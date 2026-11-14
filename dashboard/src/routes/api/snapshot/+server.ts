/* eslint-disable @typescript-eslint/no-explicit-any -- The relay payload is untrusted and allowlisted into a public shape below. */
import type { RequestHandler } from "./$types";
import {
  NO_STORE_HEADERS,
  missingRelayCredential,
  relayClient,
  safeStringList,
  safeTimestamp,
  sanitizeText,
} from "$lib/server/relay";

export const prerender = false;

function publicProduct(value: unknown) {
  const state =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const sessions = Array.isArray(state.sessions)
    ? state.sessions
        .filter((session: Record<string, any>) => !session.deletedAt)
        .slice(0, 40)
        .map((session: Record<string, any>) => ({
          sessionId: sanitizeText(session.sessionId, 160),
          title: sanitizeText(session.title, 240),
          createdAt: safeTimestamp(session.createdAt),
          updatedAt: safeTimestamp(session.updatedAt),
          turns: Array.isArray(session.turns)
            ? session.turns
                .filter((turn: Record<string, any>) => !turn.deletedAt)
                .slice(-20)
                .map((turn: Record<string, any>) => ({
                  id: sanitizeText(turn.id, 160),
                  role: sanitizeText(turn.role, 40),
                  content: sanitizeText(turn.content, 600),
                  createdAt: safeTimestamp(turn.createdAt),
                }))
            : [],
        }))
    : [];
  const memory =
    state.memory && typeof state.memory === "object" ? state.memory : {};
  const entities = Array.isArray(memory.entities)
    ? memory.entities
        .filter((entity: Record<string, any>) => !entity.deletedAt)
        .slice(0, 80)
        .map((entity: Record<string, any>) => ({
          id: sanitizeText(entity.id, 160),
          type: sanitizeText(entity.type, 80),
          name: sanitizeText(entity.name, 240),
          updatedAt: safeTimestamp(entity.updatedAt),
        }))
    : [];

  return {
    schemaVersion: sanitizeText(state.schemaVersion, 80) || null,
    revision: Number(state.revision || 0),
    sessions,
    memory: { entities },
  };
}

function publicSnapshot(
  snapshot: Record<string, any>,
  cloud: Record<string, any>,
  product: unknown,
) {
  const pipeline = Array.isArray(snapshot.pipeline)
    ? snapshot.pipeline.slice(0, 12).map((run: Record<string, any>) => ({
        pipelineId: sanitizeText(run.pipelineId, 160),
        command: sanitizeText(run.command, 300),
        status: sanitizeText(run.status, 80),
        createdAt: safeTimestamp(run.createdAt),
        updatedAt: safeTimestamp(run.updatedAt),
        events: Array.isArray(run.events)
          ? run.events.map((event: Record<string, any>) => ({
              eventId: sanitizeText(event.eventId, 160),
              stage: sanitizeText(event.stage, 80),
              status: sanitizeText(event.status, 80),
              label: sanitizeText(event.label, 160),
              detail: sanitizeText(event.detail, 500),
              text: sanitizeText(event.text, 500),
              at: safeTimestamp(event.at),
              meta: event.meta?.inputTelemetry
                ? {
                    inputTelemetry: {
                      audioBytes: Number(
                        event.meta.inputTelemetry.audioBytes || 0,
                      ),
                      durationMs: Number(
                        event.meta.inputTelemetry.durationMs || 0,
                      ),
                      sampleRate: Number(
                        event.meta.inputTelemetry.sampleRate || 0,
                      ),
                      format:
                        sanitizeText(event.meta.inputTelemetry.format, 40) ||
                        null,
                      storage:
                        sanitizeText(event.meta.inputTelemetry.storage, 80) ||
                        null,
                      inputGainDb:
                        event.meta.inputTelemetry.inputGainDb == null
                          ? null
                          : Number(event.meta.inputTelemetry.inputGainDb),
                    },
                  }
                : null,
            }))
          : [],
      }))
    : [];
  const logs = Array.isArray(snapshot.logs)
    ? snapshot.logs.slice(0, 12).map((entry: Record<string, any>) => ({
        id: sanitizeText(entry.id, 160),
        command: sanitizeText(entry.command, 300),
        status: sanitizeText(entry.status, 80),
        createdAt: safeTimestamp(entry.createdAt),
        summary: sanitizeText(entry.summary, 500),
        error: sanitizeText(entry.error, 300),
      }))
    : [];
  const sourceAgent = snapshot.status?.agent ?? {};
  const sourcePermissions = sourceAgent.permissions ?? {};
  const sourceBrowser =
    sourceAgent.browserExtension ?? snapshot.status?.browser ?? {};
  const automation =
    sourcePermissions.automation &&
    typeof sourcePermissions.automation === "object"
      ? Object.fromEntries(
          Object.entries(sourcePermissions.automation)
            .slice(0, 32)
            .map(([name, result]) => [
              sanitizeText(name, 80),
              {
                granted: Boolean(
                  result &&
                    typeof result === "object" &&
                    (result as Record<string, unknown>).granted,
                ),
              },
            ]),
        )
      : {};

  return {
    ok: Boolean(snapshot.ok),
    status: {
      agent: {
        ok: Boolean(sourceAgent.ok),
        version: sanitizeText(sourceAgent.version, 80) || null,
        hostApp: sanitizeText(sourcePermissions.hostApp, 80) || null,
        fullControlMode: Boolean(sourceAgent.fullControlMode),
        llmPlannerEnabled: Boolean(sourceAgent.llmPlannerEnabled),
        permissions: {
          ready: Boolean(sourcePermissions.ready),
          accessibility: {
            trusted: Boolean(sourcePermissions.accessibility?.trusted),
          },
          screenRecording: {
            granted: Boolean(sourcePermissions.screenRecording?.granted),
          },
          automation,
          reminders: {
            granted: Boolean(sourcePermissions.reminders?.granted),
          },
          requiredMissing: safeStringList(sourcePermissions.requiredMissing),
          optionalMissing: safeStringList(sourcePermissions.optionalMissing),
        },
        browserExtension: {
          online: Boolean(sourceBrowser.online),
          pendingCommands: Number(sourceBrowser.pendingCommands || 0),
          connectedDevices: Array.isArray(sourceBrowser.devices)
            ? sourceBrowser.devices.filter(
                (device: Record<string, unknown>) => device.online,
              ).length
            : 0,
          // Device ids and user agents never leave the server; only the newest
          // heartbeat does.
          lastSeenAt: Array.isArray(sourceBrowser.devices)
            ? sourceBrowser.devices
                .map((device: Record<string, unknown>) =>
                  String(device.lastSeenAt || ""),
                )
                .filter(Boolean)
                .sort()
                .at(-1)
              ? safeTimestamp(
                  sourceBrowser.devices
                    .map((device: Record<string, unknown>) =>
                      String(device.lastSeenAt || ""),
                    )
                    .filter(Boolean)
                    .sort()
                    .at(-1),
                )
              : null
            : null,
        },
      },
    },
    pipeline,
    logs,
    activity: logs,
    product: publicProduct(product),
    cloud: {
      ok: Boolean(cloud.ok),
      store: sanitizeText(cloud.store, 40) || null,
      speechToTextConfigured: Boolean(cloud.speechToTextConfigured),
      macBridgeOnline: Boolean(cloud.macBridgeOnline),
      models: {
        speechToText: sanitizeText(cloud.models?.speechToText, 120) || null,
        textToSpeech: sanitizeText(cloud.models?.textToSpeech, 120) || null,
      },
    },
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  const client = relayClient(locals.runtimeEnv);
  if (!client) return missingRelayCredential();
  const { relayApiKey, relayFetch } = client;

  try {
    // Order matters: /health is deliberately unauthenticated.
    const [healthResponse, stateResponse, productResponse] = await Promise.all([
      relayFetch("/health", { cache: "no-store" }),
      relayFetch("/v1/state/agent-snapshot", {
        headers: {
          Authorization: `Bearer ${relayApiKey}`,
        },
        cache: "no-store",
      }),
      relayFetch("/v1/product/state/single-owner", {
        headers: {
          Authorization: `Bearer ${relayApiKey}`,
        },
        cache: "no-store",
      }),
    ]);

    const health = await healthResponse.json().catch(() => ({}));
    const statePayload: any = await stateResponse.json().catch(() => ({}));
    const productPayload: any = await productResponse.json().catch(() => ({}));

    if (!stateResponse.ok) {
      return Response.json(
        {
          ok: false,
          error:
            statePayload.error ||
            `Cloud state refresh failed (${stateResponse.status}).`,
          cloud: health,
        },
        { status: stateResponse.status },
      );
    }

    const snapshot = statePayload.state?.data ?? {};
    return Response.json(
      {
        ...publicSnapshot(
          snapshot,
          health as Record<string, any>,
          productResponse.ok ? productPayload.state : null,
        ),
        state: {
          revision: statePayload.state?.revision ?? null,
          updatedAt: safeTimestamp(statePayload.state?.updatedAt),
          updatedBy: sanitizeText(statePayload.state?.updatedBy, 120) || null,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to reach the Cloudflare relay.",
      },
      { status: 502 },
    );
  }
};
