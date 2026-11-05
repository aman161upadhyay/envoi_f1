# Host setup probes — no Envoi credential required

These checks identify a supported **connection route** and a separate **delivery mode** before any agent receives an Envoi identity. They do not enroll a runtime. Record product/version, account/plan, date, UI or provider-documentation evidence, and whether the observation was public documentation, owner-visible UI, or an actual tool call. Leave `profiles/unverified-host.json` flags false unless the exact host demonstrates the capability. Never paste an Envoi token, browser cookie, or provider secret into a chat.

## Muse

1. Inspect the account's Connectors area and the [reviewed Connector Platform](https://platform.muse.ai/docs) submission path. Rachel selected this route for beta on 2026-10-21 and excluded user-created Custom Connectors. Record the actual account UI and submission/review status; do not infer installation from public documentation.
2. Ask the provider or inspect its documented integration contract for OAuth/private credential handling, supported read and write tools, and any supported incoming event or scheduled invocation. A submitted connector is not proof of an inbound wake path.
3. Obtain the provider submission/review ID, approved tools and classifications for the listed connector. Meta documents a separate user-created [Custom Connector](https://www.meta.com/help/superintelligence/1687253048996149/) path without Meta review, but it is outside this beta choice and cannot substitute for the reviewed approval.
4. After provider approval, test authenticated identity and availability first, then send/reply with the host's actual approval prompts. [Meta's listed-connector guidelines](https://platform.muse.ai/docs) require approval on each sensitive write; record whether Envoi send/reply is classified that way. Treat the host as **not verified for unattended wake** unless two closed-app arrivals each trigger a canonical reply without a human reopening Muse. `on_demand` is not an available v1 enrollment mode.

## ChatGPT Dots

1. Check whether the owner's account has Dots and permission to install a [custom remote MCP plugin](https://developers.openai.com/api/docs/guides/custom-mcp-server). Inspect the available OAuth flow without entering an operational Envoi token in chat. [Dot plugin access](https://learn.chatgpt.com/docs/dots/computers-and-apps) depends on installed/enabled permissions.
2. For background work, use [MCP Events](https://developers.openai.com/plugins/build/mcp-events) through Envoi's approved `provider-event-wake v1` profile: the owner asks the Dot to create a native subscription to `envoi.work_available`. A connected plugin alone does not subscribe.
3. On one gated release, install the real Envoi plugin in a disposable account. Prove authenticated identity/inbox, send/reply, subscribed closed-app delivery, durable catch-up, duplicate suppression, restart, and revoked access. A running background dot task without an Envoi subscription is not this proof.

Use [DOTS-GROK-ACCEPTANCE.md](DOTS-GROK-ACCEPTANCE.md) for the exact OAuth client metadata, MCP Events and event-subscription observations. Do not classify an ordinary remote MCP connection as a Dots wake subscription.

## Grok products and xAI API bridge

1. Name the exact product first: consumer Grok [custom MCP connector](https://docs.x.ai/grok/connectors), a [webhook-triggered Grok automation](https://docs.x.ai/grok/automations/webhooks), a [Grok Bot routine](https://docs.x.ai/grok-bot/skills-routines-and-automations), or Envoi's operator-hosted [xAI Responses API bridge](../../grok/README.md). They have separate accounts, authorization and wake evidence.
2. A consumer connector can establish a conversation-time route only after real Envoi authorization and tool calls. For an automation or Bot, inspect whether the exact account can bind that same connector to the running job; test a closed-app trigger plus authenticated claim and reply. A webhook `202` or a saved routine by itself is not completed work. The current Envoi `http-wake` signature is incompatible with Grok's webhook-trigger HMAC without a reviewed adapter.
3. Use [DOTS-GROK-ACCEPTANCE.md](DOTS-GROK-ACCEPTANCE.md) for the per-product test and `REQUEST lane-a`. Keep every profile flag false until an actual account/version passes; do not transfer xAI API bridge results to Grok consumer or Bot.

## Instinct

1. In the owner's actual Instinct account, inspect the available integrations and ask support for documented custom MCP, OAuth connector, trusted REST, private credential storage, or incoming event support. Its [public site](https://instinct.com/) establishes phone/computer use but does not specify an Envoi-compatible developer interface.
2. If only its browser/phone/email path exists, test reading the public skill once it is published and whether the agent can reach a human claim page. Do not transfer a bootstrap or operational credential through an ordinary message. Browser access alone is not a durable connector.
3. Also inspect whether this account supports a private, owner-approved browser session or API credential and a recurring task that invokes Envoi's native work and case APIs. The integrated provider browser gateway is a disabled read/notify candidate, not evidence that Instinct can log in, keep a private session, run a scheduled check or complete a case reply. If no supported private interface exists, document the exact provider restriction and keep Instinct unavailable.
4. Do not select `providerInvocation` or `verifiedWebhook` until Instinct supplies a supported event contract and two closed-app deliveries are observed. If authenticated access later works only when the owner starts a conversation, record that as a host limitation; `on_demand` enrollment waits for a later approved contract and owner label.

## Hermes, OpenClaw, and a generic HTTPS host

- Hermes/OpenClaw can evaluate a trusted local helper with private storage and a supervised process. The current `envoi-link` package is blocked by contract; the existing Phase A connectors are separate. Do not install the draft package as a replacement.
- A generic HTTPS host may qualify for the REST route only if a trusted client can keep installation credentials outside the model transcript. Reading `SKILL.md` and manually typing bearer headers do not qualify.
- For every route, run the same human claim and installation acceptance in `BREADTH-EVIDENCE.md`. Then test the actual wake mode independently. A host's brand name is never a capability flag.
