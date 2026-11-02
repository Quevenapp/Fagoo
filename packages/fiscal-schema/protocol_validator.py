"""Offline query/protocol candidate validation. Never attests SEFAZ origin or authorization."""
from __future__ import annotations

import base64
from datetime import datetime
import io
import json
from pathlib import Path
import re
import sys

from lxml import etree
from validator import (FiscalSchemaError, MAX_XML_BYTES, NS, DECLARATION,
                       _digest, _parser, _PinnedResolver)

PROFILE = "protocol-pl010d-v1.03"
PROFILE_ROOT = Path(__file__).resolve().parent / "schemas" / PROFILE
MANIFEST_SHA256 = "e49b6b35f34dc361f9a5611ac40e161fde7f2c23b32d3bc14b9a60d77c08f2ee"


def _need(condition, code):
    if not condition:
        raise FiscalSchemaError(code)


def _mod11(value):
    total = sum((ord(char) - 48) * (2 + index % 8) for index, char in enumerate(reversed(value)))
    remainder = total % 11
    return str(0 if remainder < 2 else 11 - remainder)


def _check_key(key, model):
    _need(model in ("55", "65"), "EXPECTED_MODEL_REQUIRED")
    _need(isinstance(key, str) and re.fullmatch(r"[0-9]{6}[A-Z0-9]{12}[0-9]{26}", key), "EXPECTED_KEY_INVALID")
    _need(key[-1] == _mod11(key[:-1]), "EXPECTED_KEY_INVALID")
    cnpj = key[6:20]
    first = _mod11(cnpj[:12])
    _need(not re.fullmatch(r"([0-9])\1{13}", cnpj) and cnpj[12:] == first + _mod11(cnpj[:12] + first), "EXPECTED_KEY_INVALID")
    _need(key[:2] == "35" and key[20:22] == model and 1 <= int(key[4:6]) <= 12
          and int(key[25:34]) > 0 and key[34] == "1" and int(key[22:25]) <= 889, "EXPECTED_KEY_PROFILE_UNSUPPORTED")


def _timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})", value):
        return False
    try:
        if not value.endswith("Z"):
            hours, minutes = map(int, value[-5:].split(":"))
            if hours > 14 or minutes > 59 or (hours == 14 and minutes != 0):
                return False
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.year >= 2000 and abs(parsed.utcoffset().total_seconds()) <= 14 * 3600
    except (ValueError, AttributeError):
        return False


def _text(parent, name):
    node = parent.find(NS + name)
    return node.text if node is not None else None


class ProtocolValidator:
    """Construct once per isolated process; validation mutates libxml's error log."""
    def __init__(self, profile_root=PROFILE_ROOT):
        root = Path(profile_root).resolve()
        try:
            raw = (root / "manifest.json").read_bytes()
            _need(_digest(raw) == MANIFEST_SHA256, "SCHEMA_MANIFEST_INTEGRITY_FAILED")
            manifest = json.loads(raw)
            files = {}
            for item in manifest["files"]:
                path = root / item["name"]
                _need(not path.is_symlink() and path.resolve().parent == root, "SCHEMA_FILE_INTEGRITY_FAILED")
                data = path.read_bytes()
                _need(len(data) == item["bytes"] and _digest(data) == item["sha256"], "SCHEMA_FILE_INTEGRITY_FAILED")
                files[item["name"]] = data
            self._schemas = {}
            for direction, entrypoint in manifest["entrypoints"].items():
                parser = _parser()
                parser.resolvers.add(_PinnedResolver(root, files))
                tree = etree.parse(io.BytesIO(files[entrypoint]), parser, base_url=(root / entrypoint).as_uri())
                self._schemas[direction] = etree.XMLSchema(tree)
        except FiscalSchemaError:
            raise
        except (OSError, ValueError, KeyError, etree.Error):
            raise FiscalSchemaError("SCHEMA_PROFILE_UNAVAILABLE") from None

    def validate(self, xml: bytes, *, expected_access_key: str, expected_model: str,
                 direction: str, expected_reference_digest: str | None = None) -> dict:
        _check_key(expected_access_key, expected_model)
        _need(direction in ("request", "response"), "QUERY_DIRECTION_INVALID")
        if expected_reference_digest is not None:
            _need(isinstance(expected_reference_digest, str)
                  and re.fullmatch(r"[A-Za-z0-9+/]{27}=", expected_reference_digest)
                  and base64.b64encode(base64.b64decode(expected_reference_digest)).decode() == expected_reference_digest,
                  "EXPECTED_REFERENCE_DIGEST_INVALID")
        _need(isinstance(xml, bytes) and 1 <= len(xml) <= MAX_XML_BYTES, "XML_SIZE_OR_TYPE_INVALID")
        try:
            text = xml.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise FiscalSchemaError("XML_ENCODING_INVALID") from None
        _need(not text.startswith("\ufeff") and "\x00" not in text, "XML_ENCODING_INVALID")
        body = DECLARATION.sub("", text, count=1)
        _need("<?" not in body and "<!" not in body, "XML_DECLARATION_UNSUPPORTED")
        try:
            root = etree.fromstring(xml, _parser())
        except etree.Error:
            raise FiscalSchemaError("XML_MALFORMED") from None
        _need(root.tag == NS + ("consSitNFe" if direction == "request" else "retConsSitNFe")
              and root.getprevious() is None and root.getnext() is None, "XML_QUERY_ROOT_INVALID")
        stack, count = [(root, 1)], 0
        while stack:
            node, depth = stack.pop()
            count += 1
            _need(count <= 25_000 and depth <= 80 and len(node.attrib) <= 40, "XML_TREE_LIMIT")
            _need(isinstance(node.tag, str), "XML_DECLARATION_UNSUPPORTED")
            stack.extend((child, depth + 1) for child in node)
        schema = self._schemas[direction]
        if not schema.validate(root):
            diagnostics = tuple({"line": max(0, item.line), "column": max(0, item.column),
                                 "domain": item.domain_name, "type": item.type_name}
                                for item in list(schema.error_log)[:20])
            raise FiscalSchemaError("XML_XSD_INVALID", diagnostics)
        _need(_text(root, "tpAmb") == "2", "XML_HOMOLOGATION_REQUIRED")
        _need(_text(root, "chNFe") == expected_access_key, "XML_QUERY_KEY_MISMATCH")
        result = {"schemaProfile": PROFILE, "direction": direction, "xmlDigest": _digest(xml),
                  "model": expected_model, "environment": "2", "xsdValidated": True,
                  "contextMatched": True, "verified": False, "tlsOriginVerified": False,
                  "signatureVerified": False, "sefazAuthorized": False, "canTransmit": False}
        if direction == "request":
            return result
        _need(_text(root, "cUF") == "35", "XML_QUERY_UF_MISMATCH")
        _need(_timestamp(_text(root, "dhRecbto")), "XML_QUERY_TIMESTAMP_INVALID")
        result.update({"cStat": _text(root, "cStat"), "receivedAt": _text(root, "dhRecbto"),
                       "protocol": None, "eventCount": len(root.findall(NS + "procEventoNFe")),
                       "legacyCancellationObserved": root.find(NS + "retCancNFe") is not None})
        prot = root.find(f"{NS}protNFe/{NS}infProt")
        if prot is not None:
            _need(_text(prot, "tpAmb") == "2" and _text(prot, "chNFe") == expected_access_key, "XML_PROTOCOL_CONTEXT_MISMATCH")
            _need(_timestamp(_text(prot, "dhRecbto")), "XML_PROTOCOL_TIMESTAMP_INVALID")
            number, status, reference = _text(prot, "nProt"), _text(prot, "cStat"), _text(prot, "digVal")
            if reference is not None:
                _need(re.fullmatch(r"[A-Za-z0-9+/]{27}=", reference)
                      and base64.b64encode(base64.b64decode(reference)).decode() == reference,
                      "XML_PROTOCOL_DIGEST_INVALID")
            if status in ("100", "150"):
                _need(number is not None and re.fullmatch(r"(?:[0-9]{15}|[0-9]{17})", number)
                      and int(number) > 0 and reference is not None, "XML_AUTHORIZATION_PROTOCOL_INCOMPLETE")
            if expected_reference_digest is not None:
                _need(reference == expected_reference_digest, "XML_PROTOCOL_DIGEST_MISMATCH")
            result["protocol"] = {"cStat": status, "number": number, "receivedAt": _text(prot, "dhRecbto"),
                                  "referenceDigestMatched": expected_reference_digest is not None}
        elif expected_reference_digest is not None and result["cStat"] in ("100", "150"):
            raise FiscalSchemaError("XML_AUTHORIZATION_PROTOCOL_INCOMPLETE")
        # Events are observed, never promoted to cancellation/authorization. Their signatures,
        # relationship to the original issuer, acceptance codes and event identity need a verifier.
        for event in root.findall(NS + "procEventoNFe"):
            sent = event.find(f"{NS}evento/{NS}infEvento")
            returned = event.find(f"{NS}retEvento/{NS}infEvento")
            _need(_text(sent, "tpAmb") == "2" and _text(sent, "chNFe") == expected_access_key,
                  "XML_EVENT_CONTEXT_MISMATCH")
            _need(_text(returned, "tpAmb") == "2" and _text(returned, "chNFe") in (None, expected_access_key),
                  "XML_EVENT_CONTEXT_MISMATCH")
        legacy = root.find(f"{NS}retCancNFe/{NS}infCanc")
        if legacy is not None:
            _need(_text(legacy, "tpAmb") == "2" and _text(legacy, "chNFe") in (None, expected_access_key),
                  "XML_EVENT_CONTEXT_MISMATCH")
        result["eventReconciliationRequired"] = result["eventCount"] > 0 or result["legacyCancellationObserved"] or result["cStat"] in ("101", "151")
        return result


def main() -> int:
    # Context travels in stdin, not argv/process lists. No raw XML or xMotivo is returned.
    try:
        raw = sys.stdin.buffer.read(MAX_XML_BYTES * 6 + 2049)
        _need(len(raw) <= MAX_XML_BYTES * 6 + 2048, "QUERY_INPUT_TOO_LARGE")
        data = json.loads(raw)
        _need(isinstance(data, dict) and isinstance(data.get("xml"), str), "QUERY_INPUT_INVALID")
        result = ProtocolValidator().validate(data["xml"].encode("utf-8"), expected_access_key=data.get("expectedAccessKey"),
            expected_model=data.get("expectedModel"), direction=data.get("direction"),
            expected_reference_digest=data.get("expectedReferenceDigest"))
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except (ValueError, UnicodeError, RecursionError):
        error = FiscalSchemaError("QUERY_INPUT_INVALID")
    except FiscalSchemaError as exc:
        error = exc
    print(json.dumps({"ok": False, "code": error.code, "diagnostics": error.diagnostics,
                      "verified": False, "canTransmit": False}, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
