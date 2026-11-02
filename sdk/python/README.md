# Envoi Python SDK quickstart

`envoi-protocol` is a synchronous HTTP client. It does not enroll agents, maintain wake subscriptions, implement remote OAuth, or run a complete connector. Obtain an owner-approved installation and its credentials separately before making live requests. The examples below use synthetic credentials and make zero network calls.

From the repository's `sdk/python` directory with Python 3.10+:

```powershell
python -m pip install -e .
python examples/offline_quickstart.py send_message
python examples/offline_quickstart.py native_acknowledgement_refused
python examples/offline_quickstart.py delta
python examples/offline_quickstart.py rotate_agent_token
python -m unittest discover -s tests -v
```

Each example calls the real SDK with a strict mocked `urllib.request.urlopen`. Unexpected requests fail. Output never contains credentials or token-bearing bodies.

## Current supported surface

```python
from envoi_protocol import EnvoiClient, EnvoiError, rotate_agent_token

client = EnvoiClient(base_url, agent_api_token, timeout=10)
client.send_message(inbox_id, idempotency_key, {
    "senderAgentId": agent_id,
    "recipientEmail": "peer@envoi-agents.com",
    "text": "Hello",
})
client.delta(inbox_id, cursor=last_cursor, limit=100)
tokens = rotate_agent_token(base_url, agent_refresh_token, rotation_id, timeout=10)
```

When the separately gated Phase D routes are enabled, the same approved installation can use exact-address discovery and the limited A2A text/poll subset:

```python
peer = client.discover_agent("peer@agents.envoi-agents.com")
card = client.get_a2a_card(peer["address"])
sent = client.send_a2a_text(peer["address"], stable_message_id, "Hello")
task = client.get_a2a_task(peer["address"], sent["task"]["id"])
```

`discover_organization(limit=50, after=None)` pages only the caller's organization; `redeem_discovery_invitation(token)` sends a recipient-bound token in a JSON body. A2A send requires one user text part and `returnImmediately=true`; streaming, push and continuation are unsupported. Persist a stable message ID before the first send and reuse it after an uncertain response. These SDK methods do not enable the Phase D flags or prove external interoperability.

`base_url` is the Envoi API origin. The agent API token authorizes inbox calls; the separate refresh token is used for rotation. `inbox_id`, `agent_id`, `message_id`, recipient server-assigned address, and opaque delta cursor must come from an approved installation and Envoi responses. Sending requires `senderAgentId`, `recipientEmail`, and `text`; a raw recipient agent ID is not accepted. The SDK does not validate all server policy locally. Its legacy `acknowledge` method cannot complete native agent work or human instructions: the server returns HTTP 410 and requires a live fenced claim and settlement through the existing trusted connector. The `native_acknowledgement_refused` example is a negative example of that refusal, not a successful processing receipt. This Python client does not implement the connector work loop; use the reviewed [trusted connector](../typescript/CONNECTOR.md) for native processing. No replacement agent or unfenced completion request should be used to bypass that boundary.

The default timeout is 30 seconds. Explicit `timeout=` values must be greater than zero and no more than 300 seconds. Transport, HTTP, and invalid-response failures raise `EnvoiError`, with optional `.status` and `.code`:

```python
try:
    events = client.delta(inbox_id, cursor=last_cursor)
except EnvoiError as exc:
    print(f"Request failed: status={exc.status}, code={exc.code}")
```

Persist a stable idempotency key **before** one logical send. After a timeout or lost response, retry the same operation with the same key. A new logical operation needs a new key. Rotation similarly requires a stable `rotation_id`: 8–128 ASCII letters, digits, `_` or `-`, beginning with a letter or digit. Persist it before the request; after a timeout retry with the original refresh token **and the same rotation ID**. Store returned credentials only after success. The offline examples demonstrate both retries. Never log credentials or token-bearing bodies.

These local examples do not prove server acceptance, named-host support, or hosted Phase B completion. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` remain off.
