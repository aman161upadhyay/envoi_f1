# Bounded hosted wake receiver: operator setup

This is an opt-in host composition for a **scoped** Hermes or OpenClaw installation. The trusted runtime connector, wake receiver and canonical poller run in one Node 22 process. Importing the bundle opens nothing. The operator starts that process only after the exact candidate, hosted test operations, public HTTPS URL, cost and cleanup are approved. The server's `ENVOI_HTTP_WAKE_V1` must be on for a subscription to be created.

The normal `/connect` helper start and OpenClaw Quick Connect start use this receiver when all three `ENVOI_WAKE_*` variables below are set or have been saved during service installation. Without a complete wake configuration, they retain canonical polling. The host must use the exact installed connector bundle and its existing private connection directory; no second connector may run for that enrollment. The manual host entry points below are an alternative for an operator-managed installation, not an additional process to run alongside the normal helper.

For a supervised normal connector, set the complete wake triple in the setup shell and run `setup --install-service` or `install-service --state-dir <directory>`. The installer validates and saves it as private `hosted-wake.json` under that installation's state directory before registering startup. The service manifest contains paths only; restart reads the saved settings even when the setup shell has ended. Keep the state directory across restarts. Partial environment settings, a mismatch with the saved settings, or a malformed saved file stop startup instead of silently falling back to polling.

To rotate a temporary tunnel URL or installation ID, stop the connector service, set all three variables for the replacement, then run `configure-wake --state-dir <directory>` through the installed connector CLI. Restart the service and reconcile the subscription with the server. To return deliberately to polling, stop the service, run `clear-wake --state-dir <directory>`, remove the three environment variables from the supervisor, then restart. The connector lock prevents changing wake settings while it is running. These commands store no agent token or Gateway credential in the manifest or command line.

If the manual host entry point is selected, build it from the pinned candidate before copying it to the host:

```sh
npm ci
npx vite build --config integrations/hermes/vite.config.ts
npx vite build --config integrations/openclaw/vite.config.ts
```

The Hermes artifact is `integrations/hermes/dist/run.mjs`. OpenClaw's `run.mjs` imports generated sibling `.js` files from `integrations/openclaw/dist/`; copy the **entire** OpenClaw `dist/` directory without flattening or renaming files. The root `npm run build` checks types and produces web/connector downloads, but it does **not** build these host entry points. Record the source SHA and SHA-256 of the installed Hermes file and every installed OpenClaw `dist/` file in the hosted evidence packet. If any installed hash changes, pin the new artifact graph and reassess the candidate gate. On the destination host, run the copied entry point with Node 22 and its existing scoped runtime configuration; first import the copied OpenClaw module with no configuration to confirm that import alone starts no runtime. A successful bundle build is only a packaging check, not a hosted installation or wake pass.

The selected installed connector entry point starts a separate private `wake/` directory under its persistent `ENVOI_STATE_DIR`, binds one HTTP listener on `127.0.0.1`, starts it **before** `host.run()`, then lets the host verify callbacks and poll the canonical Envoi queue. It never listens on a public interface. Abort closes the listener before releasing the wake store lock. Do not run two connector processes against the same enrollment.

If another process already owns the callback port, the connector verifies the saved Envoi installation and keeps checking its queue through the ordinary event stream and safety polling. The startup log identifies the port conflict. Free the configured port and restart the connector under its supervisor to restore callback delivery.

OpenClaw's hosted launcher acquires the shared `connector.lock` in `ENVOI_STATE_DIR` before loading or writing connection state, so a running Quick Connect process using that directory prevents a second launcher. Stop the ordinary connector under its supervisor before starting this hosted variant; keep the same private state and do not bypass the lock.

| Variable | Required value for wake |
| --- | --- |
| `ENVOI_SCOPED_TOOLS` | `true`, with the runtime's existing scoped admission and saved mode |
| `ENVOI_API_URL` | Exact staging HTTPS origin for this enrolled connector |
| `ENVOI_STATE_DIR` | Persistent private per-installation directory; retain it across restarts |
| `ENVOI_WAKE_URL` | Server-approved canonical public HTTPS callback URL with a fixed non-root path, no query or fragment |
| `ENVOI_WAKE_PORT` | Dedicated unprivileged port forwarded by TLS termination to this installation's loopback listener |
| `ENVOI_WAKE_INSTALLATION_ID` | Approved installation ID from authenticated server/owner evidence; no credential |

Keep the runtime's usual private Gateway configuration and credentials in its existing store. The wake URL and installation ID are **not** token substitutes. The process checks the saved agent/inbox identity, and the server status check must agree on installation identity before any subscription can be accepted. Use a different port, callback path and state directory for Hermes and OpenClaw. Never copy one installation's `wake/` state to another.

## Bounded Windows PC plus temporary HTTPS tunnel

This can be a first hosted test **only if** the chosen tunnel's actual URL passes Envoi's destination, DNS, TLS, challenge and SSRF checks. Do not assume that a tunnel hostname or provider is accepted. The tunnel must forward the original POST path, headers and body bytes unchanged to `http://127.0.0.1:<ENVOI_WAKE_PORT>`; no browser login, interstitial or body rewriting may sit in the callback path. Register the exact public URL returned by the server, not a URL reconstructed from proxy headers. Bring up the tunnel and host listener before any subscription attempt.

Keep the PC awake and online, and keep the tunnel, Hermes/OpenClaw Gateway and Node bridge processes running for the approved test window. Closing an app window is meaningful only if its Gateway/agent runtime remains available to do the work. A sleeping PC, stopped tunnel or stopped runtime cannot prove unattended wake. Record operator interventions, process restarts and public URL changes. A new tunnel URL requires an explicit subscription transition; do not silently recreate an ended owner subscription.

This P0 client branch combines Windows wake-store fix [#174](https://github.com/rachelgonsalves821/Envoi/pull/174) with the normal-entry launcher from [#184](https://github.com/rachelgonsalves821/Envoi/pull/184). The older `25c6637` candidate does not include those later bytes. Pin the reviewed combined head and rebuilt artifact hashes for the next release. The five previously skipped Windows composition checks now run in this branch; local success is separate from installed/hosted observations.

## Optional persistent Linux VM

For a later persistent deployment, run the same pinned `run.mjs` as a dedicated non-root service account on a VM with persistent private storage. Give Hermes and OpenClaw separate state directories and loopback ports. Configure systemd with `Restart=on-failure`, an explicit working directory, private environment file outside the source tree, and `UMask=0077`; keep the runtime Gateway supervisor separate. A reverse proxy such as Caddy can terminate TLS on public 443 and forward each **unchanged fixed path** to its corresponding loopback port. Verify route/path/Host behavior and raw-byte signature with the actual public endpoint before subscription. Do not expose the Node listener itself or put Envoi/host credentials in the proxy configuration.

The VM, DNS, certificate, runtime installation, key custody, service user, resource budget and backup location are operator choices. Example service and proxy files must be filled with the actual approved paths and URLs; a template alone cannot prove the live process or recovery behavior.

## Recovery and evidence

On restart, retain the same `ENVOI_STATE_DIR` and `wake/` store. The wake host reopens its lock and pending state, polls canonical work, renews valid subscriptions and suppresses owner-ended subscriptions. Never erase a corrupt wake store to get a green start; fail closed and reconcile with the owner/server. Prior B/C testing is human-attested complete and countersigned in [the client acceptance record](../gates/phase-c/EVIDENCE.md). Preserve those results. If a later client change requires a new check, record the exact changed build and the affected signed callback, durable acknowledgement, intended installation's canonical fetch/scoped work and effect. Missed/duplicate callbacks, restart and lifecycle checks use the specifically approved operation budget; this guide does not reopen the entire historical gate. Callback HTTP 200 alone is not a pass.

See [http-wake.md](http-wake.md) for the host/driver contract and [the P0 handoff](../gates/P0-COMPLETION.md) for remaining release/operations ownership. Lane A owns the canonical deployment packet; it is not duplicated in this client branch.
