"""Pinned local receipt XSD entrypoints over official PL010f v1.04 types."""
from __future__ import annotations
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from datetime import datetime
from urllib.parse import unquote, urlparse
from lxml import etree

PROFILE = "brufap-receipt-pl010f-v1.04"
ROOT = Path(__file__).resolve().parent / "receipt-schema"
DEPENDENCY = Path(__file__).resolve().parent.parent / "fiscal-schema/schemas/pl010f-v1.04"
MANIFEST_HASH = "01b172bfb96670a9f271c7fabf1987dc66a1fe7e2290b423f77519ed7e4bbdda"
MAX_BYTES = 512000
NS = "{http://www.portalfiscal.inf.br/nfe}"
SHA = "{http://www.w3.org/2000/09/xmldsig#}"
DECL = re.compile(r'^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>')


class ReceiptSchemaError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def need(value, code):
    if not value:
        raise ReceiptSchemaError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def parser():
    return etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                           recover=False, huge_tree=False, remove_comments=False,
                           remove_pis=False, strip_cdata=False)


class Resolver(etree.Resolver):
    def __init__(self, files):
        self.files = files

    def resolve(self, url, public_id, context):
        p = urlparse(url)
        need(p.scheme in ("", "file") and not p.netloc and not p.query and not p.fragment,
             "RECEIPT_SCHEMA_EXTERNAL_RESOURCE")
        path = Path(unquote(p.path))
        path = path if path.is_absolute() else ROOT / path
        need(path.resolve().parent == ROOT.resolve() and path.name in self.files,
             "RECEIPT_SCHEMA_EXTERNAL_RESOURCE")
        return self.resolve_string(self.files[path.name], context, base_url=(ROOT / path.name).as_uri())


def hashed_file(root, item):
    path = root / item["name"]
    need(not path.is_symlink() and path.resolve().parent == root.resolve(), "RECEIPT_SCHEMA_INTEGRITY_FAILED")
    value = path.read_bytes()
    need(len(value) == item["bytes"] and digest(value) == item["sha256"], "RECEIPT_SCHEMA_INTEGRITY_FAILED")
    return value


def stamp(value):
    need(isinstance(value, str) and re.fullmatch(r"[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})", value), "RECEIPT_TIMESTAMP_INVALID")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        need(abs(result.utcoffset().total_seconds()) <= 14 * 3600, "RECEIPT_TIMESTAMP_INVALID")
        return result
    except ValueError:
        raise ReceiptSchemaError("RECEIPT_TIMESTAMP_INVALID") from None


class Validator:
    def __init__(self):
        try:
            raw = (ROOT / "manifest.json").read_bytes()
            need(digest(raw) == MANIFEST_HASH, "RECEIPT_SCHEMA_INTEGRITY_FAILED")
            manifest = json.loads(raw)
            raw_dependency = (DEPENDENCY / "manifest.json").read_bytes()
            need(digest(raw_dependency) == manifest["dependency_manifest_sha256"], "RECEIPT_SCHEMA_INTEGRITY_FAILED")
            dependency = json.loads(raw_dependency)
            files = {v["name"]: hashed_file(DEPENDENCY, v) for v in dependency["files"]}
            files.update({v["name"]: hashed_file(ROOT, v) for v in manifest["files"]})
            p = parser()
            p.resolvers.add(Resolver(files))
            self.schemas = {kind: etree.XMLSchema(etree.parse(io.BytesIO(files[name]), p, base_url=(ROOT / name).as_uri()))
                            for kind, name in manifest["entrypoints"].items()}
        except ReceiptSchemaError:
            raise
        except (OSError, ValueError, KeyError, etree.Error):
            raise ReceiptSchemaError("RECEIPT_SCHEMA_UNAVAILABLE") from None

    def validate(self, value):
        fields = {"xml", "kind", "model", "accessKey", "referenceDigest", "issuedAt", "receiptNumber"}
        need(isinstance(value, dict) and set(value) == fields, "RECEIPT_INPUT_INVALID")
        xml, kind, model, key, reference, issued, receipt = (value[k] for k in ("xml", "kind", "model", "accessKey", "referenceDigest", "issuedAt", "receiptNumber"))
        need(kind in self.schemas and model in ("55", "65") and isinstance(key, str)
             and re.fullmatch(r"35[0-9]{4}[A-Z0-9]{12}[0-9]{26}", key) and key[20:22] == model
             and isinstance(reference, str) and re.fullmatch(r"[A-Za-z0-9+/]{27}=", reference)
             and isinstance(receipt, str) and re.fullmatch(r"[0-9]{15}", receipt) and not re.fullmatch("0+", receipt), "RECEIPT_INPUT_INVALID")
        issued_time = stamp(issued)
        need(isinstance(xml, str), "RECEIPT_INPUT_INVALID")
        try:
            raw = xml.encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise ReceiptSchemaError("RECEIPT_ENCODING_INVALID") from None
        need(0 < len(raw) <= MAX_BYTES, "RECEIPT_SIZE_LIMIT")
        need("\ufeff" not in xml and "\x00" not in xml and "<!" not in xml and "<?" not in DECL.sub("", xml, count=1), "RECEIPT_XML_DECLARATION_UNSUPPORTED")
        try:
            root = etree.fromstring(raw, parser())
        except etree.Error:
            raise ReceiptSchemaError("RECEIPT_XML_INVALID") from None
        need(root.tag == NS + {"request": "consReciNFe", "response": "retConsReciNFe"}[kind]
             and root.getprevious() is None and root.getnext() is None, "RECEIPT_ROOT_INVALID")
        count, stack = 0, [(root, 1)]
        while stack:
            element, depth = stack.pop()
            count += 1
            need(count <= 25000 and depth <= 80 and len(element.attrib) <= 40 and isinstance(element.tag, str), "RECEIPT_TREE_LIMIT")
            stack.extend((child, depth + 1) for child in element)
        need(self.schemas[kind].validate(root), "RECEIPT_XSD_INVALID")
        need(root.findtext(NS + "tpAmb") == "2" and root.findtext(NS + "nRec") == receipt, "RECEIPT_CONTEXT_MISMATCH")
        cstat, pstat, matched = None, None, False
        if kind == "response":
            need(root.findtext(NS + "cUF") == "35", "RECEIPT_CONTEXT_MISMATCH")
            stamp(root.findtext(NS + "dhRecbto"))
            cstat = root.findtext(NS + "cStat")
            protocols = root.findall(NS + "protNFe")
            need(len(protocols) == (1 if cstat == "104" else 0), "RECEIPT_SINGLE_CANDIDATE_REQUIRED")
            if protocols:
                inf = protocols[0].find(NS + "infProt")
                need(inf.findtext(NS + "tpAmb") == "2" and inf.findtext(NS + "chNFe") == key, "RECEIPT_PROTOCOL_CONTEXT_MISMATCH")
                received = stamp(inf.findtext(NS + "dhRecbto"))
                pstat, number, observed = (inf.findtext(NS + n) for n in ("cStat", "nProt", "digVal"))
                matched = observed is not None
                if observed is not None:
                    need(observed == reference, "RECEIPT_REFERENCE_MISMATCH")
                if number is not None:
                    need(not re.fullmatch("0+", number), "RECEIPT_PROTOCOL_INCOMPLETE")
                if pstat in ("100", "150"):
                    need(number is not None and matched and received >= issued_time, "RECEIPT_PROTOCOL_INCOMPLETE")
        return {"schemaProfile": PROFILE, "kind": kind, "xmlDigest": digest(raw), "model": model, "environment": "2",
                "xsdValidated": True, "contextMatched": True, "cStat": cstat, "protocolCStat": pstat,
                "referenceDigestMatched": matched, "authorizationDeclared": pstat in ("100", "150"),
                "signatureVerified": False, "tlsOriginVerified": False, "sefazAuthorized": False,
                "authorizedInHomologation": False, "canQuery": False, "canEmit": False, "canTransmit": False,
                "retrySubmissionAllowed": False}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES * 2 + 4096)
        need(len(raw) < MAX_BYTES * 2 + 4096, "RECEIPT_SIZE_LIMIT")
        value = json.loads(raw.decode("utf-8", "strict"))
        result = Validator().validate(value)
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except ReceiptSchemaError as exc:
        code = exc.code
    except (ValueError, UnicodeError, TypeError):
        code = "RECEIPT_INPUT_INVALID"
    print(json.dumps({"ok": False, "code": code, "canTransmit": False}, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
