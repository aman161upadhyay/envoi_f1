"""Verify a specific NEAR AI receipt. Reads JSON from stdin and emits boolean checks."""
import asyncio
import base64
import hashlib
import json
import re
import sys

import dcap_qvl
import requests
from eth_account import Account
from eth_account.messages import encode_defunct


def gpu_verified(attestation, nonce):
    payload = json.loads(attestation["nvidia_payload"])
    if payload["nonce"].lower() != nonce:
        return False
    response = requests.post(
        "https://nras.attestation.nvidia.com/v3/attest/gpu",
        json=payload,
        timeout=30,
        allow_redirects=False,
    )
    response.raise_for_status()
    # The verdict is obtained directly from NVIDIA over authenticated HTTPS.
    token = response.json()[0][1].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    return claims.get("x-nvidia-overall-att-result") is True and claims.get("eat_nonce", "").lower() == nonce


async def verify(evidence):
    checks = dict.fromkeys(("signed_text", "signature", "signer_attested", "report_data", "tdx_quote", "gpu"), False)
    signature = evidence["signature"]
    nonce = evidence["nonce"]
    if not re.fullmatch(r"[0-9a-f]{64}", nonce) or signature.get("signature_kind") != "provider_tee":
        return checks

    def digest(name):
        return hashlib.sha256(base64.b64decode(evidence[name], validate=True)).hexdigest()

    expected = ":".join((evidence["model"], digest("requestBase64"), digest("responseBase64")))
    checks["signed_text"] = signature["text"] == expected
    if not checks["signed_text"]:
        return checks
    address = Account.recover_message(encode_defunct(text=expected), signature=signature["signature"]).lower()
    checks["signature"] = address == signature["signing_address"].lower()
    if not checks["signature"]:
        return checks
    report = evidence["report"]

    matches = [row for row in report["model_attestations"]
               if row.get("signing_address", "").lower() == address and row.get("signing_algo", "ecdsa").lower() == "ecdsa"]
    if len(matches) != 1:
        return checks
    attestation = matches[0]
    checks.update(await verify_hardware(attestation, nonce, address))
    return checks

async def verify_hardware(attestation, nonce, address):
    checks = dict.fromkeys(("signer_attested", "report_data", "tdx_quote", "gpu"), False)
    if not re.fullmatch(r"0x[0-9a-f]{40}", address) or attestation.get("request_nonce", "").lower() != nonce:
        return checks
    quote = bytes.fromhex(attestation["intel_quote"])
    version = int.from_bytes(quote[0:2], "little")
    if int.from_bytes(quote[4:8], "little") != 0x81:
        return checks
    if version == 4:
        start = 48
    elif version == 5 and int.from_bytes(quote[48:50], "little") in (2, 3):
        start = 54
    else:
        return checks
    if len(quote) < start + 584 or quote[start + 120] & 1:
        return checks
    result = await dcap_qvl.get_collateral_and_verify(quote)
    checks["tdx_quote"] = result.status == "UpToDate"
    checks["report_data"] = quote[start + 520:start + 584] == bytes.fromhex(address[2:]).ljust(32, b"\0") + bytes.fromhex(nonce)
    checks["signer_attested"] = checks["tdx_quote"] and checks["report_data"]
    if checks["signer_attested"]:
        checks["gpu"] = gpu_verified(attestation, nonce)
    return checks


if __name__ == "__main__":
    try:
        evidence = json.load(sys.stdin)
        if sys.argv[1:] == ["--hardware-only"]:
            nonce = evidence["nonce"]
            attestation = evidence["attestation"]
            if not re.fullmatch(r"[0-9a-f]{64}", nonce):
                sys.exit(1)
            result = asyncio.run(verify_hardware(attestation, nonce, attestation["signing_address"].lower()))
        else:
            result = asyncio.run(verify(evidence))
        print(json.dumps(result))
    except Exception:
        sys.exit(1)
