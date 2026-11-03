"""Pinned local authorization XSD entrypoints over official PL010f v1.04 types."""
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

PROFILE = "brufap-authorization-pl010f-v1.04"
ROOT = Path(__file__).resolve().parent / "schema"
DEPENDENCY = Path(__file__).resolve().parent.parent / "fiscal-schema/schemas/pl010f-v1.04"
MANIFEST_HASH = "6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda"
MAX_BYTES = 512000
NS = "{http://www.portalfiscal.inf.br/nfe}"
SHA = "{http://www.w3.org/2000/09/xmldsig#}"
DECL = re.compile(r'^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>')


class AuthorizationSchemaError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def need(value, code):
    if not value:
        raise AuthorizationSchemaError(code)


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
             "AUTHORIZATION_SCHEMA_EXTERNAL_RESOURCE")
        path = Path(unquote(p.path))
        path = path if path.is_absolute() else ROOT / path
        need(path.resolve().parent == ROOT.resolve() and path.name in self.files,
             "AUTHORIZATION_SCHEMA_EXTERNAL_RESOURCE")
        return self.resolve_string(self.files[path.name], context, base_url=(ROOT / path.name).as_uri())


def hashed_file(root, item):
    path = root / item["name"]
    need(not path.is_symlink() and path.resolve().parent == root.resolve(), "AUTHORIZATION_SCHEMA_INTEGRITY_FAILED")
    value = path.read_bytes()
    need(len(value) == item["bytes"] and digest(value) == item["sha256"], "AUTHORIZATION_SCHEMA_INTEGRITY_FAILED")
    return value


def stamp(value):
    need(isinstance(value, str) and re.fullmatch(r"[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})", value), "AUTHORIZATION_TIMESTAMP_INVALID")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        need(abs(result.utcoffset().total_seconds()) <= 14 * 3600, "AUTHORIZATION_TIMESTAMP_INVALID")
        return result
    except ValueError:
        raise AuthorizationSchemaError("AUTHORIZATION_TIMESTAMP_INVALID") from None


class Validator:
    def __init__(self):
        try:
            raw = (ROOT / "manifest.json").read_bytes()
            need(digest(raw) == MANIFEST_HASH, "AUTHORIZATION_SCHEMA_INTEGRITY_FAILED")
            manifest = json.loads(raw)
            raw_dependency = (DEPENDENCY / "manifest.json").read_bytes()
            need(digest(raw_dependency) == manifest["dependency_manifest_sha256"], "AUTHORIZATION_SCHEMA_INTEGRITY_FAILED")
            dependency = json.loads(raw_dependency)
            files = {v["name"]: hashed_file(DEPENDENCY, v) for v in dependency["files"]}
            files.update({v["name"]: hashed_file(ROOT, v) for v in manifest["files"]})
            p = parser()
            p.resolvers.add(Resolver(files))
            self.schemas = {kind: etree.XMLSchema(etree.parse(io.BytesIO(files[name]), p, base_url=(ROOT / name).as_uri()))
                            for kind, name in manifest["entrypoints"].items()}
        except AuthorizationSchemaError:
            raise
        except (OSError, ValueError, KeyError, etree.Error):
            raise AuthorizationSchemaError("AUTHORIZATION_SCHEMA_UNAVAILABLE") from None

    def validate(self, value):
        need(isinstance(value, dict) and set(value) == {"xml", "kind", "expectedModel", "expectedAccessKey", "expectedReferenceDigest", "expectedBatchId"}, "AUTHORIZATION_INPUT_INVALID")
        xml, kind, model, key, reference, batch = (value[k] for k in ("xml", "kind", "expectedModel", "expectedAccessKey", "expectedReferenceDigest", "expectedBatchId"))
        need(kind in self.schemas and model in ("55", "65") and isinstance(key, str)
             and re.fullmatch(r"35[0-9]{4}[A-Z0-9]{12}[0-9]{26}", key) and key[20:22] == model
             and isinstance(reference, str) and re.fullmatch(r"[A-Za-z0-9+/]{27}=", reference)
             and isinstance(batch, str) and re.fullmatch(r"[1-9][0-9]{0,14}", batch), "AUTHORIZATION_INPUT_INVALID")
        need(isinstance(xml, str), "AUTHORIZATION_INPUT_INVALID")
        try:
            raw = xml.encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise AuthorizationSchemaError("AUTHORIZATION_ENCODING_INVALID") from None
        need(0 < len(raw) <= MAX_BYTES, "AUTHORIZATION_SIZE_LIMIT")
        need("\ufeff" not in xml and "\x00" not in xml and "<!" not in xml and "<?" not in DECL.sub("", xml, count=1), "AUTHORIZATION_XML_DECLARATION_UNSUPPORTED")
        try:
            root = etree.fromstring(raw, parser())
        except etree.Error:
            raise AuthorizationSchemaError("AUTHORIZATION_XML_INVALID") from None
        need(root.tag == NS + {"request": "enviNFe", "response": "retEnviNFe", "processed": "nfeProc"}[kind]
             and root.getprevious() is None and root.getnext() is None, "AUTHORIZATION_ROOT_INVALID")
        count, stack = 0, [(root, 1)]
        while stack:
            element, depth = stack.pop()
            count += 1
            need(count <= 25000 and depth <= 80 and len(element.attrib) <= 40 and isinstance(element.tag, str), "AUTHORIZATION_TREE_LIMIT")
            stack.extend((child, depth + 1) for child in element)
        # Do not expose libxml messages: they can contain private source values.
        need(self.schemas[kind].validate(root), "AUTHORIZATION_XSD_INVALID")
        protocol = root.find(NS + "protNFe")
        cstat = root.findtext(NS + "cStat") if kind == "response" else None
        pstat = None
        if kind in ("request", "processed"):
            nfes = root.findall(NS + "NFe")
            need(len(nfes) == 1, "AUTHORIZATION_SINGLE_NFE_REQUIRED")
            inf = nfes[0].find(NS + "infNFe")
            need(inf is not None and inf.get("Id") == "NFe" + key and inf.findtext(f"{NS}ide/{NS}mod") == model
                 and inf.findtext(f"{NS}ide/{NS}cUF") == "35" and inf.findtext(f"{NS}ide/{NS}tpAmb") == "2"
                 and inf.findtext(f"{NS}ide/{NS}tpEmis") == "1", "AUTHORIZATION_CONTEXT_MISMATCH")
            digests = nfes[0].findall(f"{SHA}Signature/{SHA}SignedInfo/{SHA}Reference/{SHA}DigestValue")
            need(len(digests) == 1 and digests[0].text == reference, "AUTHORIZATION_REFERENCE_MISMATCH")
            if kind == "request":
                need(root.findtext(NS + "idLote") == batch and root.findtext(NS + "indSinc") == "1", "AUTHORIZATION_BATCH_MISMATCH")
        if kind == "response":
            need(root.findtext(NS + "tpAmb") == "2" and root.findtext(NS + "cUF") == "35", "AUTHORIZATION_CONTEXT_MISMATCH")
            stamp(root.findtext(NS + "dhRecbto"))
            receipt = root.find(NS + "infRec")
            if cstat == "103":
                need(receipt is not None and protocol is None and not re.fullmatch("0+", receipt.findtext(NS + "nRec") or ""), "AUTHORIZATION_BATCH_MISMATCH")
            elif cstat == "104":
                need(protocol is not None and receipt is None, "AUTHORIZATION_BATCH_MISMATCH")
            else:
                need(protocol is None and receipt is None, "AUTHORIZATION_BATCH_MISMATCH")
        matched = False
        if protocol is not None:
            inf = protocol.find(NS + "infProt")
            need(inf.findtext(NS + "tpAmb") == "2" and inf.findtext(NS + "chNFe") == key, "AUTHORIZATION_PROTOCOL_CONTEXT_MISMATCH")
            stamp(inf.findtext(NS + "dhRecbto"))
            pstat, number, observed = (inf.findtext(NS + n) for n in ("cStat", "nProt", "digVal"))
            matched = observed is not None
            if observed is not None:
                need(observed == reference, "AUTHORIZATION_REFERENCE_MISMATCH")
            if pstat in ("100", "150"):
                need(number is not None and not re.fullmatch("0+", number) and matched, "AUTHORIZATION_PROTOCOL_INCOMPLETE")
            if kind == "processed":
                need(pstat in ("100", "150"), "AUTHORIZATION_PROCESSED_STATUS_INVALID")
                need(stamp(inf.findtext(NS + "dhRecbto")) >= stamp(root.findtext(f"{NS}NFe/{NS}infNFe/{NS}ide/{NS}dhEmi")), "AUTHORIZATION_TIMESTAMP_INVALID")
        return {"schemaProfile": PROFILE, "kind": kind, "xmlDigest": digest(raw), "model": model, "environment": "2",
                "xsdValidated": True, "contextMatched": True, "cStat": cstat, "protocolCStat": pstat,
                "referenceDigestMatched": matched, "authorizationDeclared": pstat in ("100", "150"),
                "signatureVerified": False, "tlsOriginVerified": False, "sefazAuthorized": False,
                "authorizedInHomologation": False, "canEmit": False, "canTransmit": False}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES * 2 + 4096)
        need(len(raw) < MAX_BYTES * 2 + 4096, "AUTHORIZATION_SIZE_LIMIT")
        value = json.loads(raw.decode("utf-8", "strict"))
        result = Validator().validate(value)
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except AuthorizationSchemaError as exc:
        code = exc.code
    except (ValueError, UnicodeError, TypeError):
        code = "AUTHORIZATION_INPUT_INVALID"
    print(json.dumps({"ok": False, "code": code, "canTransmit": False}, separators=(",", ":")))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
