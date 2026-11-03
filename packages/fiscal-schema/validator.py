"""Offline, pinned NF-e XSD candidate validation. No fiscal authorization."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlparse

from lxml import etree

PROFILE = "pl010f-v1.04"
PROFILE_ROOT = Path(__file__).resolve().parent / "schemas" / PROFILE
MANIFEST_SHA256 = "6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0"
MAX_XML_BYTES = 512_000  # Application limit shared with fiscal-xml, not a SEFAZ assertion.
NS = "{http://www.portalfiscal.inf.br/nfe}"
DECLARATION = re.compile(r'^<\?xml\s+version=["\']1\.0["\'](?:\s+encoding=["\']UTF-8["\'])?\s*\?>', re.I)


class FiscalSchemaError(Exception):
    def __init__(self, code: str, diagnostics: tuple = ()):
        super().__init__(code)
        self.code = code
        self.diagnostics = diagnostics


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class _PinnedResolver(etree.Resolver):
    """Only previously hashed bytes can satisfy an XSD include/import."""
    def __init__(self, root: Path, files: dict[str, bytes]):
        self.root, self.files = root.resolve(), files

    def resolve(self, url, public_id, context):
        parsed = urlparse(url)
        if parsed.scheme not in ("", "file") or parsed.netloc or parsed.query or parsed.fragment:
            raise FiscalSchemaError("SCHEMA_EXTERNAL_RESOURCE_FORBIDDEN")
        path = Path(unquote(parsed.path))
        path = path if path.is_absolute() else self.root / path
        if path.resolve().parent != self.root or path.name not in self.files:
            raise FiscalSchemaError("SCHEMA_EXTERNAL_RESOURCE_FORBIDDEN")
        return self.resolve_string(self.files[path.name], context, base_url=(self.root / path.name).as_uri())


def _parser() -> etree.XMLParser:
    return etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                           recover=False, huge_tree=False, remove_comments=False,
                           remove_pis=False, strip_cdata=False)


class Validator:
    """Construct once per isolated process. Do not mutate/share across concurrent calls."""
    def __init__(self, profile_root: Path = PROFILE_ROOT):
        root = Path(profile_root).resolve()
        try:
            manifest_bytes = (root / "manifest.json").read_bytes()
            if _digest(manifest_bytes) != MANIFEST_SHA256:
                raise FiscalSchemaError("SCHEMA_MANIFEST_INTEGRITY_FAILED")
            manifest = json.loads(manifest_bytes)
            files = {}
            for item in manifest["files"]:
                path = root / item["name"]
                if path.is_symlink() or path.resolve().parent != root:
                    raise FiscalSchemaError("SCHEMA_FILE_INTEGRITY_FAILED")
                data = path.read_bytes()
                if len(data) != item["bytes"] or _digest(data) != item["sha256"]:
                    raise FiscalSchemaError("SCHEMA_FILE_INTEGRITY_FAILED")
                files[item["name"]] = data
            parser = _parser()
            parser.resolvers.add(_PinnedResolver(root, files))
            tree = etree.parse(io.BytesIO(files[manifest["entrypoint"]]), parser,
                               base_url=(root / manifest["entrypoint"]).as_uri())
            self._schema = etree.XMLSchema(tree)
        except FiscalSchemaError:
            raise
        except (OSError, ValueError, KeyError, etree.Error) as exc:
            raise FiscalSchemaError("SCHEMA_PROFILE_UNAVAILABLE") from None

    def validate(self, xml: bytes, *, expected_model: str) -> dict:
        if expected_model not in ("55", "65"):
            raise FiscalSchemaError("EXPECTED_MODEL_REQUIRED")
        if not isinstance(xml, bytes) or not 1 <= len(xml) <= MAX_XML_BYTES:
            raise FiscalSchemaError("XML_SIZE_OR_TYPE_INVALID")
        try:
            text = xml.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise FiscalSchemaError("XML_ENCODING_INVALID") from None
        # Candidate policy deliberately matches the narrow signature input profile.
        if text.startswith("\ufeff") or "\x00" in text:
            raise FiscalSchemaError("XML_ENCODING_INVALID")
        without_declaration = DECLARATION.sub("", text, count=1)
        if "<?" in without_declaration or "<!" in without_declaration:
            raise FiscalSchemaError("XML_DECLARATION_UNSUPPORTED")
        try:
            root = etree.fromstring(xml, _parser())
        except etree.Error:
            raise FiscalSchemaError("XML_MALFORMED") from None
        if root.tag != NS + "NFe" or root.getprevious() is not None or root.getnext() is not None:
            raise FiscalSchemaError("XML_NFE_ROOT_INVALID")
        count = 0
        stack = [(root, 1)]
        while stack:
            element, depth = stack.pop()
            count += 1
            if count > 25_000 or depth > 80 or len(element.attrib) > 40:
                raise FiscalSchemaError("XML_TREE_LIMIT")
            if not isinstance(element.tag, str):
                raise FiscalSchemaError("XML_DECLARATION_UNSUPPORTED")
            stack.extend((child, depth + 1) for child in element)
        models = root.findall(f"{NS}infNFe/{NS}ide/{NS}mod")
        environments = root.findall(f"{NS}infNFe/{NS}ide/{NS}tpAmb")
        if len(models) != 1 or models[0].text != expected_model:
            raise FiscalSchemaError("XML_EXPECTED_MODEL_MISMATCH")
        if len(environments) != 1 or environments[0].text != "2":
            raise FiscalSchemaError("XML_HOMOLOGATION_REQUIRED")
        if not self._schema.validate(root):
            # libxml messages and paths can contain private XML values. Never return them.
            diagnostics = tuple({"line": max(0, item.line), "column": max(0, item.column),
                                 "domain": item.domain_name, "type": item.type_name}
                                for item in list(self._schema.error_log)[:20])
            raise FiscalSchemaError("XML_XSD_INVALID", diagnostics)
        return {"schemaProfile": PROFILE, "xmlDigest": _digest(xml), "model": expected_model,
                "environment": "2", "xsdValidated": True, "signatureVerified": False,
                "taxRulesValidated": False, "icpBrasilChainValidated": False,
                "revocationChecked": False, "sefazAuthorized": False, "canTransmit": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=("55", "65"))
    args = parser.parse_args()
    try:
        result = Validator().validate(sys.stdin.buffer.read(MAX_XML_BYTES + 1), expected_model=args.model)
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except FiscalSchemaError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "diagnostics": exc.diagnostics,
                          "canTransmit": False}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
