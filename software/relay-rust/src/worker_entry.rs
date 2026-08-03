//! Worker entry point: CORS, authentication, scope checking, dispatch.
//!
//! Middleware order matters and mirrors `server.js` exactly:
//!   1. `cors()` — answers every OPTIONS before auth, and stamps
//!      `Access-Control-Allow-Origin` on every response.
//!   2. body parsing.
//!   3. `GET /health` and `POST /v1/devices/pair`, registered BEFORE the auth
//!      middleware and therefore public.
//!   4. auth + scope check — an unknown (method, path) pair has no scope entry
//!      and yields 403, never 404.
//!   5. everything else.

use worker::{event, Context, Env, Method, Request, Response, Result};

use crate::config::Config;
use crate::device_auth::{
    classify_authorization, principal_has_scopes, should_touch_credential, verify_device_token,
    AuthAttempt, Principal, AUTH_ERROR, SCOPE_ERROR,
};
use crate::http;
use crate::routing::{required_scopes, resolve};
use crate::store::d1::D1Store;
use crate::util::time::{iso_from_ms, now_ms};

#[event(start)]
fn start() {
    // Turn wasm panics into readable logs instead of an opaque 1101.
    console_error_panic_hook::set_once();
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match handle(req, env).await {
        Ok(response) => Ok(response),
        Err(error) => {
            worker::console_error!("[relay] unhandled error: {error}");
            http::error_response(500, "Internal relay error.")
        }
    }
}

async fn handle(mut req: Request, env: Env) -> Result<Response> {
    // 1. CORS preflight is answered before authentication, on every path.
    if req.method() == Method::Options {
        return http::preflight(&req);
    }

    let path = req.path();
    let method = method_name(&req.method());
    let cfg = Config::from_env(&env);

    let db = env.d1("DB")?;
    let store = D1Store::new(db, cfg.job_ttl_ms);

    // 2. Public routes, registered before the auth middleware.
    if method == "GET" && path == "/health" {
        return crate::routes::devices::health(&env, &cfg, &store).await;
    }
    if method == "POST" && path == "/v1/devices/pair" {
        let body = http::parse_json_body(&mut req).await;
        if matches!(body, http::JsonBody::Malformed) {
            return http::malformed_body_response();
        }
        return crate::routes::devices::pair(&cfg, &store, &body).await;
    }

    // 3. Authenticate.
    let authorization = http::header(&req, "authorization");
    let principal = match authenticate(&authorization, &cfg, &store).await? {
        Some(principal) => principal,
        None => return http::error_response(401, AUTH_ERROR),
    };

    // 4. Scope check. A missing entry is a 403 for EVERY principal, including
    //    the admin key — this is what makes unknown paths 403 rather than 404.
    let Some(required) = required_scopes(method, &path) else {
        return http::error_response(403, SCOPE_ERROR);
    };
    if !principal_has_scopes(&principal, required) {
        return http::error_response(403, SCOPE_ERROR);
    }

    // 5. Dispatch.
    let Some(route) = resolve(method, &path) else {
        // Unreachable in practice: every scoped path resolves.
        return http::error_response(403, SCOPE_ERROR);
    };

    crate::routes::dispatch(route, req, env, cfg, store, principal).await
}

fn method_name(method: &Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Patch => "PATCH",
        Method::Delete => "DELETE",
        Method::Head => "HEAD",
        Method::Options => "OPTIONS",
        Method::Connect => "CONNECT",
        Method::Trace => "TRACE",
    }
}

/// Port of `authenticateRelayRequest`.
async fn authenticate(
    authorization: &str,
    cfg: &Config,
    store: &D1Store,
) -> Result<Option<Principal>> {
    match classify_authorization(authorization, &cfg.relay_api_key) {
        AuthAttempt::Admin => Ok(Some(Principal::admin())),
        AuthAttempt::MissingBearer | AuthAttempt::InvalidBearer => Ok(None),
        AuthAttempt::Device(parsed) => {
            let Some(record) = store.get_device_credential(&parsed.token_id).await? else {
                return Ok(None);
            };
            let now = now_ms();
            let token = format!("pdt_{}.{}", parsed.token_id, parsed.secret);
            if !verify_device_token(&token, &record, now) {
                return Ok(None);
            }

            // Throttled last-used writeback, at most once a minute.
            if should_touch_credential(&record, now) {
                store
                    .touch_device_credential(&record.token_id, &iso_from_ms(now))
                    .await?;
            }

            Ok(Some(Principal::device(&record)))
        }
    }
}
