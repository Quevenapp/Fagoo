/** Public fiscal table transcription, not product data or a licensing registry. */
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
// Keep worksheet order and source rows, including the non-sorted Japan range.
export const GTIN_PREFIX_TABLE=deepFreeze([
 {
  "from": "000",
  "to": "019",
  "specialIllustrative": false,
  "sourceRow": 2
 },
 {
  "from": "020",
  "to": "029",
  "specialIllustrative": true,
  "sourceRow": 3
 },
 {
  "from": "030",
  "to": "039",
  "specialIllustrative": false,
  "sourceRow": 4
 },
 {
  "from": "040",
  "to": "049",
  "specialIllustrative": true,
  "sourceRow": 5
 },
 {
  "from": "050",
  "to": "059",
  "specialIllustrative": true,
  "sourceRow": 6
 },
 {
  "from": "060",
  "to": "139",
  "specialIllustrative": false,
  "sourceRow": 7
 },
 {
  "from": "200",
  "to": "299",
  "specialIllustrative": true,
  "sourceRow": 8
 },
 {
  "from": "300",
  "to": "379",
  "specialIllustrative": false,
  "sourceRow": 9
 },
 {
  "from": "380",
  "to": "380",
  "specialIllustrative": false,
  "sourceRow": 10
 },
 {
  "from": "383",
  "to": "383",
  "specialIllustrative": false,
  "sourceRow": 11
 },
 {
  "from": "385",
  "to": "385",
  "specialIllustrative": false,
  "sourceRow": 12
 },
 {
  "from": "387",
  "to": "387",
  "specialIllustrative": false,
  "sourceRow": 13
 },
 {
  "from": "389",
  "to": "389",
  "specialIllustrative": false,
  "sourceRow": 14
 },
 {
  "from": "400",
  "to": "440",
  "specialIllustrative": false,
  "sourceRow": 15
 },
 {
  "from": "450",
  "to": "459",
  "specialIllustrative": false,
  "sourceRow": 16
 },
 {
  "from": "490",
  "to": "499",
  "specialIllustrative": false,
  "sourceRow": 17
 },
 {
  "from": "460",
  "to": "469",
  "specialIllustrative": false,
  "sourceRow": 18
 },
 {
  "from": "470",
  "to": "470",
  "specialIllustrative": false,
  "sourceRow": 19
 },
 {
  "from": "471",
  "to": "471",
  "specialIllustrative": false,
  "sourceRow": 20
 },
 {
  "from": "474",
  "to": "474",
  "specialIllustrative": false,
  "sourceRow": 21
 },
 {
  "from": "475",
  "to": "475",
  "specialIllustrative": false,
  "sourceRow": 22
 },
 {
  "from": "476",
  "to": "476",
  "specialIllustrative": false,
  "sourceRow": 23
 },
 {
  "from": "477",
  "to": "477",
  "specialIllustrative": false,
  "sourceRow": 24
 },
 {
  "from": "478",
  "to": "478",
  "specialIllustrative": false,
  "sourceRow": 25
 },
 {
  "from": "479",
  "to": "479",
  "specialIllustrative": false,
  "sourceRow": 26
 },
 {
  "from": "480",
  "to": "480",
  "specialIllustrative": false,
  "sourceRow": 27
 },
 {
  "from": "481",
  "to": "481",
  "specialIllustrative": false,
  "sourceRow": 28
 },
 {
  "from": "482",
  "to": "482",
  "specialIllustrative": false,
  "sourceRow": 29
 },
 {
  "from": "483",
  "to": "483",
  "specialIllustrative": false,
  "sourceRow": 30
 },
 {
  "from": "484",
  "to": "484",
  "specialIllustrative": false,
  "sourceRow": 31
 },
 {
  "from": "485",
  "to": "485",
  "specialIllustrative": false,
  "sourceRow": 32
 },
 {
  "from": "486",
  "to": "486",
  "specialIllustrative": false,
  "sourceRow": 33
 },
 {
  "from": "487",
  "to": "487",
  "specialIllustrative": false,
  "sourceRow": 34
 },
 {
  "from": "488",
  "to": "488",
  "specialIllustrative": false,
  "sourceRow": 35
 },
 {
  "from": "489",
  "to": "489",
  "specialIllustrative": false,
  "sourceRow": 36
 },
 {
  "from": "500",
  "to": "509",
  "specialIllustrative": false,
  "sourceRow": 37
 },
 {
  "from": "520",
  "to": "521",
  "specialIllustrative": false,
  "sourceRow": 38
 },
 {
  "from": "528",
  "to": "528",
  "specialIllustrative": false,
  "sourceRow": 39
 },
 {
  "from": "529",
  "to": "529",
  "specialIllustrative": false,
  "sourceRow": 40
 },
 {
  "from": "530",
  "to": "530",
  "specialIllustrative": false,
  "sourceRow": 41
 },
 {
  "from": "531",
  "to": "531",
  "specialIllustrative": false,
  "sourceRow": 42
 },
 {
  "from": "535",
  "to": "535",
  "specialIllustrative": false,
  "sourceRow": 43
 },
 {
  "from": "539",
  "to": "539",
  "specialIllustrative": false,
  "sourceRow": 44
 },
 {
  "from": "540",
  "to": "549",
  "specialIllustrative": false,
  "sourceRow": 45
 },
 {
  "from": "560",
  "to": "560",
  "specialIllustrative": false,
  "sourceRow": 46
 },
 {
  "from": "569",
  "to": "569",
  "specialIllustrative": false,
  "sourceRow": 47
 },
 {
  "from": "570",
  "to": "579",
  "specialIllustrative": false,
  "sourceRow": 48
 },
 {
  "from": "590",
  "to": "590",
  "specialIllustrative": false,
  "sourceRow": 49
 },
 {
  "from": "594",
  "to": "594",
  "specialIllustrative": false,
  "sourceRow": 50
 },
 {
  "from": "599",
  "to": "599",
  "specialIllustrative": false,
  "sourceRow": 51
 },
 {
  "from": "600",
  "to": "601",
  "specialIllustrative": false,
  "sourceRow": 52
 },
 {
  "from": "603",
  "to": "603",
  "specialIllustrative": false,
  "sourceRow": 53
 },
 {
  "from": "604",
  "to": "604",
  "specialIllustrative": false,
  "sourceRow": 54
 },
 {
  "from": "608",
  "to": "608",
  "specialIllustrative": false,
  "sourceRow": 55
 },
 {
  "from": "609",
  "to": "609",
  "specialIllustrative": false,
  "sourceRow": 56
 },
 {
  "from": "611",
  "to": "611",
  "specialIllustrative": false,
  "sourceRow": 57
 },
 {
  "from": "613",
  "to": "613",
  "specialIllustrative": false,
  "sourceRow": 58
 },
 {
  "from": "615",
  "to": "615",
  "specialIllustrative": false,
  "sourceRow": 59
 },
 {
  "from": "616",
  "to": "616",
  "specialIllustrative": false,
  "sourceRow": 60
 },
 {
  "from": "618",
  "to": "618",
  "specialIllustrative": false,
  "sourceRow": 61
 },
 {
  "from": "619",
  "to": "619",
  "specialIllustrative": false,
  "sourceRow": 62
 },
 {
  "from": "620",
  "to": "620",
  "specialIllustrative": false,
  "sourceRow": 63
 },
 {
  "from": "621",
  "to": "621",
  "specialIllustrative": false,
  "sourceRow": 64
 },
 {
  "from": "622",
  "to": "622",
  "specialIllustrative": false,
  "sourceRow": 65
 },
 {
  "from": "623",
  "to": "623",
  "specialIllustrative": false,
  "sourceRow": 66
 },
 {
  "from": "624",
  "to": "624",
  "specialIllustrative": false,
  "sourceRow": 67
 },
 {
  "from": "625",
  "to": "625",
  "specialIllustrative": false,
  "sourceRow": 68
 },
 {
  "from": "626",
  "to": "626",
  "specialIllustrative": false,
  "sourceRow": 69
 },
 {
  "from": "627",
  "to": "627",
  "specialIllustrative": false,
  "sourceRow": 70
 },
 {
  "from": "628",
  "to": "628",
  "specialIllustrative": false,
  "sourceRow": 71
 },
 {
  "from": "629",
  "to": "629",
  "specialIllustrative": false,
  "sourceRow": 72
 },
 {
  "from": "640",
  "to": "649",
  "specialIllustrative": false,
  "sourceRow": 73
 },
 {
  "from": "690",
  "to": "699",
  "specialIllustrative": false,
  "sourceRow": 74
 },
 {
  "from": "700",
  "to": "709",
  "specialIllustrative": false,
  "sourceRow": 75
 },
 {
  "from": "729",
  "to": "729",
  "specialIllustrative": false,
  "sourceRow": 76
 },
 {
  "from": "730",
  "to": "739",
  "specialIllustrative": false,
  "sourceRow": 77
 },
 {
  "from": "740",
  "to": "740",
  "specialIllustrative": false,
  "sourceRow": 78
 },
 {
  "from": "741",
  "to": "741",
  "specialIllustrative": false,
  "sourceRow": 79
 },
 {
  "from": "742",
  "to": "742",
  "specialIllustrative": false,
  "sourceRow": 80
 },
 {
  "from": "743",
  "to": "743",
  "specialIllustrative": false,
  "sourceRow": 81
 },
 {
  "from": "744",
  "to": "744",
  "specialIllustrative": false,
  "sourceRow": 82
 },
 {
  "from": "745",
  "to": "745",
  "specialIllustrative": false,
  "sourceRow": 83
 },
 {
  "from": "746",
  "to": "746",
  "specialIllustrative": false,
  "sourceRow": 84
 },
 {
  "from": "750",
  "to": "750",
  "specialIllustrative": false,
  "sourceRow": 85
 },
 {
  "from": "754",
  "to": "755",
  "specialIllustrative": false,
  "sourceRow": 86
 },
 {
  "from": "759",
  "to": "759",
  "specialIllustrative": false,
  "sourceRow": 87
 },
 {
  "from": "760",
  "to": "769",
  "specialIllustrative": false,
  "sourceRow": 88
 },
 {
  "from": "770",
  "to": "771",
  "specialIllustrative": false,
  "sourceRow": 89
 },
 {
  "from": "773",
  "to": "773",
  "specialIllustrative": false,
  "sourceRow": 90
 },
 {
  "from": "775",
  "to": "775",
  "specialIllustrative": false,
  "sourceRow": 91
 },
 {
  "from": "777",
  "to": "777",
  "specialIllustrative": false,
  "sourceRow": 92
 },
 {
  "from": "778",
  "to": "779",
  "specialIllustrative": false,
  "sourceRow": 93
 },
 {
  "from": "780",
  "to": "780",
  "specialIllustrative": false,
  "sourceRow": 94
 },
 {
  "from": "784",
  "to": "784",
  "specialIllustrative": false,
  "sourceRow": 95
 },
 {
  "from": "786",
  "to": "786",
  "specialIllustrative": false,
  "sourceRow": 96
 },
 {
  "from": "789",
  "to": "790",
  "specialIllustrative": false,
  "sourceRow": 97
 },
 {
  "from": "800",
  "to": "839",
  "specialIllustrative": false,
  "sourceRow": 98
 },
 {
  "from": "840",
  "to": "849",
  "specialIllustrative": false,
  "sourceRow": 99
 },
 {
  "from": "850",
  "to": "850",
  "specialIllustrative": false,
  "sourceRow": 100
 },
 {
  "from": "858",
  "to": "858",
  "specialIllustrative": false,
  "sourceRow": 101
 },
 {
  "from": "859",
  "to": "859",
  "specialIllustrative": false,
  "sourceRow": 102
 },
 {
  "from": "860",
  "to": "860",
  "specialIllustrative": false,
  "sourceRow": 103
 },
 {
  "from": "865",
  "to": "865",
  "specialIllustrative": false,
  "sourceRow": 104
 },
 {
  "from": "867",
  "to": "867",
  "specialIllustrative": false,
  "sourceRow": 105
 },
 {
  "from": "868",
  "to": "869",
  "specialIllustrative": false,
  "sourceRow": 106
 },
 {
  "from": "870",
  "to": "879",
  "specialIllustrative": false,
  "sourceRow": 107
 },
 {
  "from": "880",
  "to": "880",
  "specialIllustrative": false,
  "sourceRow": 108
 },
 {
  "from": "884",
  "to": "884",
  "specialIllustrative": false,
  "sourceRow": 109
 },
 {
  "from": "885",
  "to": "885",
  "specialIllustrative": false,
  "sourceRow": 110
 },
 {
  "from": "888",
  "to": "888",
  "specialIllustrative": false,
  "sourceRow": 111
 },
 {
  "from": "890",
  "to": "890",
  "specialIllustrative": false,
  "sourceRow": 112
 },
 {
  "from": "893",
  "to": "893",
  "specialIllustrative": false,
  "sourceRow": 113
 },
 {
  "from": "896",
  "to": "896",
  "specialIllustrative": false,
  "sourceRow": 114
 },
 {
  "from": "899",
  "to": "899",
  "specialIllustrative": false,
  "sourceRow": 115
 },
 {
  "from": "900",
  "to": "919",
  "specialIllustrative": false,
  "sourceRow": 116
 },
 {
  "from": "930",
  "to": "939",
  "specialIllustrative": false,
  "sourceRow": 117
 },
 {
  "from": "940",
  "to": "949",
  "specialIllustrative": false,
  "sourceRow": 118
 },
 {
  "from": "950",
  "to": "950",
  "specialIllustrative": true,
  "sourceRow": 119
 },
 {
  "from": "951",
  "to": "951",
  "specialIllustrative": true,
  "sourceRow": 120
 },
 {
  "from": "955",
  "to": "955",
  "specialIllustrative": false,
  "sourceRow": 121
 },
 {
  "from": "958",
  "to": "958",
  "specialIllustrative": false,
  "sourceRow": 122
 },
 {
  "from": "960",
  "to": "969",
  "specialIllustrative": true,
  "sourceRow": 123
 },
 {
  "from": "977",
  "to": "977",
  "specialIllustrative": true,
  "sourceRow": 124
 },
 {
  "from": "978",
  "to": "979",
  "specialIllustrative": true,
  "sourceRow": 125
 },
 {
  "from": "980",
  "to": "980",
  "specialIllustrative": true,
  "sourceRow": 126
 },
 {
  "from": "981",
  "to": "984",
  "specialIllustrative": true,
  "sourceRow": 127
 },
 {
  "from": "990",
  "to": "999",
  "specialIllustrative": true,
  "sourceRow": 128
 }
]);
export const GTIN_PREFIX_MANIFEST=deepFreeze({
 "profile": "nfe-gs1-prefix-observed-20261016-v1",
 "observedOn": "2026-10-16",
 "source": {
  "title": "Tabela Prefixo GS1 — Portal Nacional da NF-e",
  "url": "https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=Oc%20fygAxwmc=",
  "indexUrl": "https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=%2FNJarYc9nus%3D",
  "sha256": "6f75b924f7fc97a2b5c4b6483479c035304ec642b48eebc61bd2b1afb5b62606",
  "sizeBytes": 22170,
  "publisherVersion": null,
  "internalModifiedAt": "2017-10-19T12:41:53Z",
  "effectiveFrom": null,
  "ranges": {
   "sheet": "Prefixo GS1",
   "cells": "A2:C128",
   "count": 127,
   "sha256": "4aa57784b9c1be68465a608d9be357a6873ee0d00ba250856b3ca67cbbeaee4a"
  },
  "instructions": {
   "sheet": "Valida GTIN",
   "cells": [
    "D9:F17",
    "D26:F36"
   ]
  }
 },
 "algorithm": {
  "acceptedLengths": [
   8,
   12,
   13,
   14
  ],
  "comparisonRepresentation": "left_zero_pad_to_14_only",
  "prefixWhenFirstSixZero": "positions_7_to_9_1_based",
  "prefixOtherwise": "positions_2_to_4_1_based",
  "rangesInclusive": true,
  "specialFlagIsIllustrative": true
 },
 "references": [
  {
   "title": "NT 2021.003 v1.50",
   "url": "https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=ENot2yWE72Q=",
   "sha256": "28b7e26b1a515cdd8180084a71c6b8bf4eb6fa7745ecafba878fbeb75547b363",
   "pages": [
    11,
    12,
    13,
    46
   ]
  },
  {
   "title": "GS1 General Specifications, Release 26.0, Ratified Jan 26",
   "url": "https://ref.gs1.org/standards/genspecs/",
   "sha256": "d32eae37039bdce4931714d6eae73fd682d060c692edecc23620233b0733efe6",
   "pages": [
    26,
    27,
    28,
    35,
    36,
    98,
    106
   ]
  }
 ],
 "limitations": [
  "Snapshot observed on the given date; metadata is not an official effective date.",
  "Fiscal table, not a current global allocation/licensing catalogue.",
  "No CCG consultation or product assignment check.",
  "No country of origin or packaging quantity inference.",
  "No tax classification, SEFAZ response, permission to emit or transmit."
 ]
});
// SHA-256 of UTF-8 JSON.stringify(manifest), verified in the unit test. No runtime I/O.
export const GTIN_PREFIX_MANIFEST_HASH='de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140';
