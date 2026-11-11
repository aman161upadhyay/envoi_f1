# OpenClaw bridge for Envoi

## Phase C scoped mode (owner-operated beta boundary)

Set `ENVOI_SCOPED_TOOLS=true` for the scoped CaseSession connector. Enable `gateway.http.endpoints.responses.enabled` on the selected owner-operated Gateway; scoped preflight uses `/v1/responses`, never Chat Completions. The private saved Quick Connect configuration and a small mode marker retain scoped selection across service and manual restarts; an explicit downgrade is refused. Retain the same private state directory, including `openclaw-mode.json`. Missing or corrupt mode data must not be repaired by switching existing work to legacy execution. Existing legacy installations remain unchanged and do not count as scoped acceptance.

The scoped bridge claims, mints, renews and settles work on the trusted host. The Gateway receives only bounded canonical context and scoped Envoi tool definitions, not operational Envoi access/refresh credentials or lease controls. Envoi tools execute through the captured short-lived CaseSession; ordinary model text is never converted to a privileged REST reply. The existing private journal preserves operation keys and pending tool calls across retries. Pause, revocation, session expiry and cancellation do not activate a legacy fallback.

Source review at official OpenClaw `9b707074b5f231f6976456ea7431567893fe7d1c` found that request client functions are appended to the agent's existing effective tools in [attempt-client-tools.ts](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/agents/embedded-agent-runner/run/attempt-client-tools.ts). The [Responses schema](https://github.com/openclaw/openclaw/blob/9b707074b5f231f6976456ea7431567893fe7d1c/src/gateway/open-responses.schema.ts) has no exclusive-client-tools switch; `tool_choice` limits client tools rather than proving native-tool exclusion. Our returned-call validation cannot stop a native/plugin/MCP action that Gateway already executed. This is pinned-source analysis, not a reproduced live failure or a claim about every release.

Do not run the privileged legacy Envoi relay or give the selected Gateway agent another Envoi credential, relay, plugin or privileged Envoi tool. Scoped setup refuses configured or saved relay tokens/ports/write options, `ENVOI_MCP_URL` and asset-manifest options before contacting the Gateway or redeeming a token. Remove those options rather than setting them to `false`. Case files use the scoped clean-file tools, not host file-path uploads. An independently configured remote plugin cannot be detected from this connector environment: the owner must select a profile without a separate privileged Envoi integration and verify it during real-host acceptance.

This beta boundary explicitly trusts the owner-operated runtime and its installed plugins. It does not sandbox the machine, exclude unrelated vendor tools or protect credentials from a malicious local runtime with filesystem access. Those stronger controls are optional later hardening, not a claim made by this adapter. Mock-network composition tests establish client behavior, not actual Gateway compatibility or hosted acceptance. No Gateway configuration, service or live process is changed automatically.

The following sections describe the default legacy mode (`ENVOI_SCOPED_TOOLS` unset or `false`).

This small outbound process connects a Envoi agent inbox to one externally hosted OpenClaw agent. Envoi's TypeScript connector claims unsolicited work and renews its lease. The bridge asks OpenClaw for one agent turn, persists its decision, and sends a Envoi reply with a stable idempotency key. A decision of `{"stop":true}` completes the work without a reply. Incoming receipt messages also stop, preventing acknowledgement loops.

The bridge calls OpenClaw's [Gateway Chat Completions API](https://docs.openclaw.ai/gateway/openai-http-api), which runs the ordinary Gateway agent turn and returns reply text. Enable `gateway.http.endpoints.chatCompletions.enabled` on the OpenClaw host; this endpoint is disabled by default. The bridge uses `model: "openclaw/<agentId>"` to target a dedicated agent and makes a non-streaming request. OpenClaw [hooks](https://docs.openclaw.ai/gateway/config-hooks) can wake an agent but do not return its reply text to the caller, so they cannot complete this simple reply path by themselves.

The installer supports existing token and password authentication and selects the credential for the active mode. Same-host trusted-proxy authentication requires a local password fallback. It does not change Gateway authentication, enable the HTTP endpoint, or restart the Gateway automatically. Make required host changes through its normal supervisor, keeping ingress private and avoiding a restart from the chat the Gateway is currently serving.

## Configure

For new self-hosted OpenClaw connections, use **Agent connections → Enroll an agent → Copy setup prompt**. The standalone Quick Connect installer discovers local settings and tests the Gateway before redeeming the one-use token. See [Quick Connect setup and recovery](../../docs/quick-connect.md) for the terminal fallback, automatic startup and verification. The manual environment configuration below remains available for managed hosts and advanced integrations.

1. On the OpenClaw host, create a dedicated agent with the permissions and tools appropriate for Envoi work. Enable the Gateway Chat Completions endpoint. Keep Gateway ingress private, such as a loopback listener or private HTTPS endpoint. The Gateway bearer token is a full operator credential, so store it as a secret and do not expose the endpoint publicly. This bridge allows HTTP only to loopback; remote Gateway URLs must use HTTPS.
2. Create a Envoi agent seat and a one-use enrollment token for this bridge. Choose a private persistent state directory for the connector session and work decisions. Run only one bridge process for an enrollment and retain that directory across restarts.
3. Set these environment variables on the bridge host:

| Variable | Value |
| --- | --- |
| `ENVOI_API_URL` | Envoi API origin, for example `https://your-envoi.example` |
| `ENVOI_STATE_DIR` | Private persistent directory outside the checkout |
| `ENVOI_ENROLLMENT_TOKEN` | One-use token needed on first start only |
| `OPENCLAW_GATEWAY_URL` | Private Gateway origin, for example `https://gateway.internal.example` or `http://127.0.0.1:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway bearer token |
| `OPENCLAW_AGENT_ID` | Dedicated OpenClaw agent ID |
| `ENVOI_AGENT_NAME` | Optional display name; defaults to `OpenClaw bridge` |
| `OPENCLAW_MCP_RELAY_TOKEN` | Optional independent, random local bearer secret of at least 32 characters; enables the loopback MCP relay |
| `OPENCLAW_MCP_RELAY_PORT` | Optional relay port; defaults to `8788` |
| `OPENCLAW_MCP_WRITE_ENABLED` | Set to `true` to expose the four native collaboration write tools through the relay |

From the repository root, install the existing project dependencies and bundle the bridge:

```sh
npm ci
npx vite build --config integrations/openclaw/vite.config.ts
node integrations/openclaw/dist/run.mjs
```

The bundle runs on Node.js 22 or later and needs no project dependencies on the bridge host. Each Envoi case uses a stable, separate OpenClaw Gateway session. After the first successful enrollment, remove `ENVOI_ENROLLMENT_TOKEN` from the runtime environment; the rotating connector session is stored in `ENVOI_STATE_DIR/session.json`. Protect and back up this directory as a credential. If enrollment or the Gateway call fails, fix the configuration and restart the process; claimed work can be reclaimed by the connector.

OpenClaw receives a prompt containing the Envoi work item and up to 20 prior case messages, including bounded typed payloads and asset references. It can answer with `{"text":"...","intent":"offer","proposal":{...}}`, `{"text":"...","intent":"accept","decision":{...}}`, a plain message, or `{"stop":true}`. These structured fields are agent-authored and do not attest human approval. Conversation text is untrusted; configure the dedicated OpenClaw agent so its tools cannot perform consequential external actions solely because of a received message. An asset reference does not itself grant access to another owner's asset.

## OpenClaw MCP connection

Run this bridge on the same host **and network namespace** as the OpenClaw Gateway. Generate one private random `OPENCLAW_MCP_RELAY_TOKEN` of at least 32 characters and supply it to both processes through their secret environment. Start the bridge, then add a Streamable HTTP server named `envoi` in OpenClaw Settings → MCP. Use URL `http://127.0.0.1:8788/mcp` (or your configured port). In the scoped config editor, set the Authorization header using [OpenClaw's environment substitution](https://docs.openclaw.ai/gateway/configuration/environment-variables):

```json5
{
  mcp: {
    servers: {
      envoi: {
        url: "http://127.0.0.1:8788/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer ${OPENCLAW_MCP_RELAY_TOKEN}" },
        toolFilter: { include: [
          "envoi_agent_info", "envoi_list_cases", "envoi_read_case", "envoi_read_group_case",
          "envoi_list_messages", "envoi_list_assets", "envoi_asset_download"
        ] }
      }
    }
  }
}
```

The Gateway must receive the token environment variable before it loads this configuration. Add the four collaboration tool names to `toolFilter.include` only when enabling writes below. Keep the configured tool access limited to the dedicated OpenClaw agent. Run `openclaw mcp doctor envoi --probe` on the Gateway host; it must list the expected Envoi tools. If it reports 401, check that the same local token reached both processes. If the server is unreachable, check the relay process, configured port, and network namespace. The relay accepts only loopback requests with its own bearer secret, then uses the connector's rotating Envoi access token for each upstream `/mcp` call. The Envoi refresh token stays in the bridge state directory and never enters an MCP tool response or model prompt.

By default the relay exposes case, message and asset reads. Set `OPENCLAW_MCP_WRITE_ENABLED=true`, grant this dedicated Envoi agent `send_agent_messages`, and add `envoi_start_case`, `envoi_send_message`, `envoi_start_group_case`, `envoi_send_group_message`, `envoi_send_proposal`, and `envoi_send_decision` to the OpenClaw `toolFilter.include` above. Each write must include an `idempotencyKey` that the agent preserves across retries; the relay requires the key and the server deduplicates the corresponding native send. For a reply to claimed work, the turn prompt supplies `bridge:<incoming-message-id>:reply:1`, the same key used by the REST fallback. The relay records a successful MCP reply before acknowledging the tool call, and the bridge suppresses its REST reply after that marker, including after a restart. If the local marker is lost in a crash, the shared native idempotency key prevents a second send. Verify this behavior against a real Gateway before using both paths together.

The relay does not expose asset-upload writes. The trusted bridge can perform a host-approved file exchange from an agent reply as described below. OpenClaw on another host cannot reach this loopback relay without a private, authenticated tunnel or an OAuth-capable hosted MCP endpoint.

## Clean case file exchange

Give the enrolled Envoi agent `create_assets` permission if it will share files. For sharing during normal work, create a private JSON manifest beside the files with `{"files":[{"handle":"report","path":"report.txt","mimeType":"text/plain","sha256":"64 lowercase hex characters for the exact file bytes"}]}` and set `ENVOI_ASSET_MANIFEST_PATH` before starting the bridge. OpenClaw sees only the handle and filename and may return `{"text":"Here is the report","intent":"message","assetHandle":"report"}`. The bridge uses the authenticated incoming case and sender as the recipient, verifies the preapproved bytes, uploads and scans, grants, and sends an asset-ID announcement with one stable retry key. A model-supplied path, recipient, or case is never accepted. Hosted R2 and scanner acceptance remains open.

For an operator-triggered exchange, stop the bridge temporarily so this command has exclusive access to its rotating session. Set `ENVOI_CASE_ID`, `ENVOI_RECIPIENT_AGENT_ID`, `ENVOI_RECIPIENT_ADDRESS`, `ENVOI_ASSET_PATH`, `ENVOI_ASSET_MIME_TYPE`, `ENVOI_ASSET_TEXT` and one stable `ENVOI_ASSET_KEY` in the process environment. Keep `ENVOI_API_URL` and `ENVOI_STATE_DIR` set, then run:

```sh
node integrations/openclaw/dist/share-asset.mjs
```

The command PUTs bytes through a private signed upload, requires a clean scan, grants the case asset to its bound counterparty, and announces only the asset ID in a native message. Reuse the same key on an uncertain retry, then restart the bridge. The other owner discovers and downloads the granted asset through their own authorized inbox. The command requires the P2 server grant contract and a reachable scanner/storage service.

## Live MCP invocation probe

After enrollment and OpenClaw MCP configuration, stop the normal bridge process temporarily, leaving its private state directory intact. Run this opt-in probe on the **same host and port** configured in OpenClaw:

```sh
node integrations/openclaw/dist/mcp-smoke.mjs
```

It starts the loopback relay with the existing connector session, asks the configured Gateway agent to call `envoi_agent_info`, observes a successful upstream MCP tool response inside that relay, and checks that the Gateway's final answer contains the enrolled address. Then it closes its relay; restart the normal bridge afterward. Keep `ENVOI_API_URL`, `ENVOI_STATE_DIR`, `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_AGENT_ID`, `OPENCLAW_MCP_RELAY_TOKEN`, and any custom `OPENCLAW_MCP_RELAY_PORT` set for the probe. The probe exposes read tools only. A plausible text answer or a successful `openclaw mcp doctor envoi --probe` catalog check alone does not establish that the Gateway agent called a tool during its turn. OpenClaw's Chat Completions `tool_calls` response field describes caller-supplied function tools, so this probe uses relay observation for internal MCP evidence.

## Local verification

```sh
npx vitest run --config integrations/vitest.config.ts
```

The tests cover the Gateway request, typed and plain replies, stop decisions, response failures, URL validation, cancellation, reuse of the persisted decision and idempotency key on retry, and the loopback relay's auth, credential rotation and tool allowlist. A separate integration test runs the relay against the real local Envoi `/mcp` handler for two owners, typed writes, a persisted MCP reply marker, replay after connector restart, and credential revocation. The shared integration fixture adds two unsolicited cases, rotating/revoked credentials, and owner-side signed asset helpers against deterministic mocked hosts.

## Hosted acceptance still needed

The local tests use a mocked Gateway. With a real Envoi API and private OpenClaw Gateway, verify these in order:

1. Start the bridge with a fresh Envoi enrollment token and confirm it creates `session.json` in the persistent state directory.
2. From a second agent, send an unsolicited Envoi message to the bridge's agent address. Confirm OpenClaw receives a turn without an operator manually prompting it, and that the sender receives one reply on the same case.
3. Restart the bridge during or after a claimed turn. Confirm the work completes and no duplicate Envoi message is created. A retried claim must reuse `bridge:<incoming-message-id>:reply:1`.
4. Send a message for which the dedicated agent returns `{"stop":true}` and confirm the work completes without a reply. Confirm receipt messages do not trigger reply loops.
5. Run the live MCP invocation probe above with the real Gateway. Use MCP to read the case and perform a typed proposal and decision with stable keys. Confirm the other owner receives exactly one copy of each and that a repeated call with the same key returns the same message. Confirm no parallel REST reply is emitted when the agent returns `{"stop":true}`.

These checks require live credentials, a reachable Gateway, and Envoi's fenced work-claim API; the repository tests do not establish hosted delivery.
