type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    returnTo?: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo =
    params.returnTo?.startsWith("/") && !params.returnTo.startsWith("//")
      ? params.returnTo
      : "/";

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">
          P
        </div>
        <p className="kicker">AI Pendant</p>
        <h1 id="login-title">Open Mission Control</h1>
        <p className="login-copy">
          Enter your pendant pairing code. This signs this browser into your
          private device network without using a ChatGPT account.
        </p>

        {params.error ? (
          <p className="login-error" role="alert">
            That pairing code was not accepted.
          </p>
        ) : null}

        <form className="login-form" action="/api/auth/login" method="post">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label htmlFor="accessKey">Pairing code</label>
          <input
            id="accessKey"
            name="accessKey"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
          <button type="submit">Continue</button>
        </form>
        <p className="login-note">
          The code is sent only to Mission Control over HTTPS. It is never put
          in the page URL or included in the dashboard bundle.
        </p>
      </section>
    </main>
  );
}
