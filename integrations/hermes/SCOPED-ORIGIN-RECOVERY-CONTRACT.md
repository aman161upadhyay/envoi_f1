# Scoped Hermes Gateway origin recovery contract

## Verified boundary

The selected local Hermes source at `ccc695635094d7615373db267b77f894d978b1a0` calls `start_gateway_api(runner)` from `gateway/run_runtime.py`; `start_gateway_api` defaults to `port=0` in `gateway/run_api.py`. The Gateway publishes the actual bound `api_origin` through its live control-socket `identify` descriptor. The Envoi scoped marker and turn identity pin the prior origin. A restart may therefore bind a different loopback port. The current connector correctly stops with `SCOPED_CONFIG_INVALID` when a live descriptor disagrees with the saved origin. It must not guess, rewrite private authority records, create another agent, or resume an uncertain turn against a different endpoint.

This source inspection establishes a **blocker for unattended scoped Gateway restart**, not proof that every Gateway restart changes port. The source and any candidate build used in a gate must be rechecked by exact SHA.

## Required supported upstream capability

The Hermes owner must provide and document one of these supported contracts:

1. **Stable origin:** a fixed loopback runtime API port selected by the owner, reserved before the Gateway claims readiness, with a clear bind failure and no silent random-port fallback. The live `identify.api_origin` remains identical across controlled restarts. Its service definition must retain that configuration. This is the smallest route to unattended reconnect with Envoi's current pin.
2. **Versioned origin rotation:** an authenticated, profile-bound continuity proof and owner-confirmed reselection operation that identifies the same durable authority across old and new origins. The operation must compare the saved selection, reject a different profile/authority, fence active or uncertain turns, and atomically update only supported selection records. Envoi may adopt this only after an explicit protocol review; the current `session-authority-v1` origin pin is not permission to follow a new port automatically.

Until one contract is implemented and gated, host supervision can restart the Gateway process but cannot promise seamless scoped Envoi recovery when its origin changes. The safe owner action is to keep the saved connection and turn journal, inspect the live Gateway descriptor, and use the upstream supported owner-confirmed procedure once available. Do not edit `hermes-scoped.json` or other private authority files by hand.

## Exact-build gate

On an approved disposable staging profile, record the Hermes source SHA, connector artifact SHA, profile and authority identifiers privately, and the original `api_origin`. Keep Envoi enrollment, installation, inbox and journal unchanged. Stop only the selected Gateway after it has no active turn; let its host supervisor restart it. Repeat enough times to observe port selection, including a bind conflict if stable-origin support is offered. For each restart verify the live `identify` descriptor, the connector's safe status, and a real scoped tool action. Deliver work while the runtime is down, then prove one claim, one fenced settlement and one reply after recovery. Count idle model calls and duplicate registrations. A changed origin without the supported continuity protocol must fail closed and require owner action; it cannot be counted as seamless recovery.
