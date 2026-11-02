import io
import json
import socket
import unittest
from unittest.mock import patch
from urllib import error

from envoi_protocol import EnvoiClient, EnvoiError, rotate_agent_token


class Response:
    def __init__(self, body=b"{}", status=200):
        self.body = body
        self.status = status

    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self): return self.body


class ClientTests(unittest.TestCase):
    @patch("envoi_protocol.request.urlopen")
    def test_path_segments_encode_slashes_and_timeout_is_forwarded(self, urlopen):
        urlopen.return_value = Response(json.dumps({"events": []}).encode())
        client = EnvoiClient("https://api.example", "secret-token", timeout=7)
        client.delta("inbox/../../other")
        call = urlopen.call_args.args[0]
        self.assertIn("/api/inboxes/inbox%2F..%2F..%2Fother/events/delta", call.full_url)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 7)

    @patch("envoi_protocol.request.urlopen")
    def test_json_http_error_is_sanitized(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 409, "Conflict", {}, io.BytesIO(b'{"error":"Conflict","code":"REUSED"}'))
        with self.assertRaises(EnvoiError) as raised:
            EnvoiClient("https://api.example", "do-not-leak").delta("inbox")
        self.assertEqual(str(raised.exception), "Conflict")
        self.assertEqual(raised.exception.status, 409)
        self.assertNotIn("do-not-leak", str(raised.exception))

    @patch("envoi_protocol.request.urlopen")
    def test_html_and_timeout_errors_do_not_expose_remote_bodies(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 502, "Bad Gateway", {}, io.BytesIO(b"<html>provider secret</html>"))
        with self.assertRaisesRegex(EnvoiError, "HTTP 502"):
            EnvoiClient("https://api.example", "token").delta("inbox")
        urlopen.side_effect = socket.timeout()
        with self.assertRaisesRegex(EnvoiError, "timed out"):
            EnvoiClient("https://api.example", "token").delta("inbox")

    @patch("envoi_protocol.request.urlopen")
    def test_stable_error_uses_display_message_and_preserves_code(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 409, "Conflict", {},
            io.BytesIO(b'{"error":"AGENT_PAUSED","code":"AGENT_PAUSED","message":"This agent is paused"}'))
        with self.assertRaises(EnvoiError) as raised:
            EnvoiClient("https://api.example", "token").delta("inbox")
        self.assertEqual(str(raised.exception), "This agent is paused")
        self.assertEqual(raised.exception.code, "AGENT_PAUSED")

    @patch("envoi_protocol.request.urlopen")
    def test_phase_d_discovery_and_a2a_use_exact_address_and_immediate_text(self, urlopen):
        urlopen.return_value = Response(b'{}')
        client = EnvoiClient("https://api.example", "agent-secret")
        client.discover_agent("peer+one@agents.example")
        self.assertTrue(urlopen.call_args.args[0].full_url.endswith("/api/agent/discovery?address=peer%2Bone%40agents.example"))
        client.discover_organization(limit=3, after="inbox/one")
        self.assertIn("scope=organization&limit=3&after=inbox%2Fone", urlopen.call_args.args[0].full_url)
        client.redeem_discovery_invitation("signed-token")
        self.assertEqual(json.loads(urlopen.call_args.args[0].data), {"invitation": "signed-token"})
        client.get_a2a_card("peer+one@agents.example")
        self.assertTrue(urlopen.call_args.args[0].full_url.endswith("/api/agent/a2a/agents/peer%2Bone%40agents.example/card"))
        client.send_a2a_text("peer+one@agents.example", "message-1", "hello")
        call = urlopen.call_args.args[0]
        self.assertEqual(dict(call.header_items())["Content-type"], "application/a2a+json")
        self.assertEqual(json.loads(call.data), {"message": {"messageId": "message-1", "role": "ROLE_USER", "parts": [{"text": "hello"}]}, "configuration": {"returnImmediately": True}})
        client.get_a2a_task("peer+one@agents.example", "case/one")
        self.assertTrue(urlopen.call_args.args[0].full_url.endswith("/api/agent/a2a/agents/peer%2Bone%40agents.example/tasks/case%2Fone"))

    @patch("envoi_protocol.request.urlopen")
    def test_phase_d_a2a_error_keeps_nested_code_without_exposing_credentials(self, urlopen):
        urlopen.side_effect = error.HTTPError("https://api.example", 403, "Forbidden", {},
            io.BytesIO(b'{"error":{"code":"AUTHORIZATION_DENIED","message":"Access denied"}}'))
        with self.assertRaises(EnvoiError) as raised:
            EnvoiClient("https://api.example", "private-token").get_a2a_card("peer@agents.example")
        self.assertEqual(raised.exception.code, "AUTHORIZATION_DENIED")
        self.assertEqual(str(raised.exception), "Access denied")
        self.assertNotIn("private-token", str(raised.exception))

    def test_timeout_is_bounded(self):
        with self.assertRaises(ValueError): EnvoiClient("https://api.example", "token", timeout=0)
        with self.assertRaises(ValueError): EnvoiClient("https://api.example", "token", timeout=301)

    @patch("envoi_protocol.request.urlopen")
    def test_rotation_requires_and_transmits_a_stable_request_id(self, urlopen):
        urlopen.return_value = Response(json.dumps({
            "agentApiToken": "access-two", "agentRefreshToken": "refresh-two",
            "agentTokenExpiresAt": "2030-01-01T00:00:00Z", "agentRefreshTokenExpiresAt": "2030-02-01T00:00:00Z"
        }).encode())
        with self.assertRaises(ValueError): rotate_agent_token("https://api.example", "refresh-one", "short")
        self.assertFalse(urlopen.called)
        rotated = rotate_agent_token("https://api.example", "refresh-one", "rotation-python-1")
        self.assertEqual(rotated.agent_refresh_token, "refresh-two")
        body = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(body, {"grantType": "refresh_token", "agentRefreshToken": "refresh-one", "rotationId": "rotation-python-1"})


if __name__ == "__main__": unittest.main()
