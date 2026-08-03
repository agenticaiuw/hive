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
        <h1 id="login-title">Dashboard</h1>
        <p className="login-copy">Enter your pairing code.</p>

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
          Your code is sent only to the dashboard over HTTPS and never appears
          in the page URL.
        </p>
      </section>
    </main>
  );
}
