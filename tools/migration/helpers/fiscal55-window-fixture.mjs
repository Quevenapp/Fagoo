// Synthetic metadata based on a homologation scenario. No customer/taxpayer identity, certificate or XML bytes.
// Every opaque object/row/certificate digest below is regenerated from an explicit stable fixture path.
// Public contract/manifest hashes and internal references are preserved; this is not an exported database snapshot.
import {createHash} from 'node:crypto';
const fixtureDigest=path=>createHash('sha256').update('fagoo-fiscal55-fixture-v1:'+path).digest('hex');
const baseline={
  "a1": {
    "version": 1,
    "not_after": "2027-06-01T19:57:59.000Z",
    "configured": true,
    "not_before": "2026-06-01T19:57:59.000Z",
    "updated_at": "2026-10-16T12:22:57.431786+00:00",
    "object_hash": fixtureDigest("baseline.a1.object_hash"),
    "credential_id": "00000000-0000-4000-8000-000000000001",
    "bytes_verified": false,
    "company_matches": true,
    "private_key_opened": false,
    "time_valid_at_snapshot": true,
    "certificate_fingerprint": fixtureDigest("baseline.a1.certificate_fingerprint"),
    "object_metadata_matches": true,
    "company_identity_version": 1,
    "private_bucket_metadata_matches": true
  },
  "checks": {
    "original_total_8481": true,
    "single_active_admin": true,
    "original_order_unique": true,
    "inventory_not_truncated": true,
    "historical65_4352_present": true,
    "original_reserved55_42194": true,
    "target_is_different_order": true,
    "authorization_heads_closed": true,
    "contact_active_pf_customer": false,
    "receipt_query_heads_closed": true,
    "target_exists_if_requested": true,
    "catalog_contact_same_document": true,
    "current_product_active_code_unit": true,
    "series55_matches_current_identity": true,
    "target_unprepared_without_effects": true,
    "original_single_item_1cx_total8481": true,
    "target_same_contact_and_exact_price": true
  },
  "counts": {
    "sales_orders": 3,
    "receipt_queries": 0,
    "sales_numbering_last": "3",
    "authorization_attempts": 2,
    "authorization_consumed": 2,
    "receipt_query_consumed": 0,
    "authorization_unresolved": 0
  },
  "limits": {
    "can_emit": false,
    "can_transmit": false,
    "can_create_order": false,
    "storage_bytes_read": false,
    "tax_rules_validated": false,
    "database_snapshot_only": true,
    "runtime_flags_observed": false,
    "historical_rows_rewritten": false,
    "authenticated_actor_proven": false,
    "no_global_preservation_claim": true
  },
  "catalog": {
    "contact": {
      "id": "00000000-0000-4000-8000-000000000002",
      "state": "SP",
      "active": true,
      "version": 1,
      "row_hash": fixtureDigest("baseline.catalog.contact.row_hash"),
      "person_type": "F",
      "origin_state": "synced",
      "customer_role": false,
      "document_present": true,
      "origin_source_id": "10001",
      "snapshot_version": 1,
      "origin_applied_hash": fixtureDigest("baseline.catalog.contact.origin_applied_hash"),
      "document_matches_original_snapshot": true
    },
    "products": [
      {
        "id": "00000000-0000-4000-8000-000000000003",
        "ncm": "40082100",
        "code": "345121",
        "gtin": null,
        "kind": "P",
        "unit": "CX",
        "active": true,
        "format": "S",
        "version": 1,
        "row_hash": fixtureDigest("baseline.catalog.products[0].row_hash"),
        "origin_state": "synced",
        "catalog_price": "84.8062444176",
        "origin_source_id": "10001",
        "origin_applied_hash": fixtureDigest("baseline.catalog.products[0].origin_applied_hash")
      }
    ]
  },
  "company": {
    "crt": "1",
    "state": "SP",
    "confirmed_at": "2026-10-16T10:15:05.43069+00:00",
    "identity_hash": fixtureDigest("baseline.company.identity_hash"),
    "fiscal_version": 2,
    "identity_version": 1
  },
  "contract": "homologation-55-next-baseline-v1",
  "series55": {
    "id": "00000000-0000-4000-8000-000000000004",
    "model": "55",
    "series": 2,
    "enabled": true,
    "version": 2,
    "row_hash": fixtureDigest("baseline.series55.row_hash"),
    "updated_at": "2026-10-17T03:51:57.158384+00:00",
    "environment": "2",
    "next_number": "42195",
    "first_number": 42194,
    "identity_matches": true,
    "identity_version": 1,
    "exclusive_use_confirmed": true
  },
  "read_only": true,
  "selection": {
    "unit": "CX",
    "model": "55",
    "series": 2,
    "quantity": "1",
    "environment": "2",
    "expected_total": "84.81",
    "target_order_id": null,
    "unit_price_from": "original_order_item",
    "expected_product_code": "345121",
    "original_order_number": "1"
  },
  "observed_at": "2026-10-17T10:00:00.000Z",
  "protocol062": {
    "used": 0,
    "attempts": 0,
    "sql_policy_exists": false,
    "runtime_flag_observed": false
  },
  "reservations": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000005",
        "actor": "00000000-0000-4000-8000-000000000006",
        "model": "65",
        "number": 4351,
        "series": 2,
        "draft_id": "00000000-0000-4000-8000-000000000007",
        "row_hash": fixtureDigest("baseline.reservations.items[0].row_hash"),
        "series_id": "00000000-0000-4000-8000-000000000008",
        "environment": "2",
        "reserved_at": "2026-10-17T05:20:52.843406+00:00",
        "draft_version": 1,
        "series_version": 1,
        "source_document_id": "00000000-0000-4000-8000-000000000009",
        "source_document_version": 1
      },
      {
        "id": "00000000-0000-4000-8000-000000000010",
        "actor": "00000000-0000-4000-8000-000000000006",
        "model": "55",
        "number": 42194,
        "series": 2,
        "draft_id": "00000000-0000-4000-8000-000000000011",
        "row_hash": fixtureDigest("baseline.reservations.items[1].row_hash"),
        "series_id": "00000000-0000-4000-8000-000000000004",
        "environment": "2",
        "reserved_at": "2026-10-17T03:51:57.159588+00:00",
        "draft_version": 1,
        "series_version": 1,
        "source_document_id": "00000000-0000-4000-8000-000000000012",
        "source_document_version": 1
      },
      {
        "id": "00000000-0000-4000-8000-000000000013",
        "actor": "00000000-0000-4000-8000-000000000006",
        "model": "65",
        "number": 4352,
        "series": 2,
        "draft_id": "00000000-0000-4000-8000-000000000014",
        "row_hash": fixtureDigest("baseline.reservations.items[2].row_hash"),
        "series_id": "00000000-0000-4000-8000-000000000008",
        "environment": "2",
        "reserved_at": "2026-10-17T06:00:45.148487+00:00",
        "draft_version": 1,
        "series_version": 2,
        "source_document_id": "00000000-0000-4000-8000-000000000015",
        "source_document_version": 1
      }
    ],
    "total": 3,
    "truncated": false
  },
  "target_order": null,
  "original_order": {
    "id": "00000000-0000-4000-8000-000000000012",
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000016",
        "code": "345121",
        "unit": "CX",
        "total": "84.81",
        "position": 1,
        "quantity": "1.000000",
        "row_hash": fixtureDigest("baseline.original_order.items[0].row_hash"),
        "product_id": "00000000-0000-4000-8000-000000000003",
        "unit_price": "84.8062444176",
        "discount_percent": "0.0000",
        "snapshot_version": 1
      }
    ],
    "total": "84.81",
    "number": 1,
    "status": "draft",
    "version": 1,
    "row_hash": fixtureDigest("baseline.original_order.row_hash"),
    "body_hash": fixtureDigest("baseline.original_order.body_hash"),
    "contact_id": "00000000-0000-4000-8000-000000000002",
    "created_at": "2026-10-17T03:45:52.216188+00:00",
    "item_count": 1,
    "updated_at": "2026-10-17T03:45:52.216188+00:00",
    "warehouse_id": null,
    "fiscal_drafts": 1,
    "billing_titles": 0,
    "stock_postings": 0,
    "finance_postings": 0,
    "commercial_summary": {
      "date": "2026-10-17",
      "freight": "0.00",
      "discount_mode": "amount",
      "notes_present": true,
      "discount_value": "0.00",
      "other_expenses": "0.00",
      "commercial_present": true,
      "installments_count": 0,
      "payment_terms_present": false,
      "delivery_terms_present": false,
      "internal_notes_present": true
    },
    "stock_reservations": 0,
    "fiscal_reservations": 1
  },
  "related_orders": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000015",
        "total": "84.81",
        "number": 3,
        "status": "draft",
        "version": 1,
        "created_at": "2026-10-17T05:54:07.386224+00:00",
        "updated_at": "2026-10-17T05:54:07.386224+00:00"
      },
      {
        "id": "00000000-0000-4000-8000-000000000009",
        "total": "84.81",
        "number": 2,
        "status": "draft",
        "version": 1,
        "created_at": "2026-10-17T05:05:27.493973+00:00",
        "updated_at": "2026-10-17T05:05:27.493973+00:00"
      },
      {
        "id": "00000000-0000-4000-8000-000000000012",
        "total": "84.81",
        "number": 1,
        "status": "draft",
        "version": 1,
        "created_at": "2026-10-17T03:45:52.216188+00:00",
        "updated_at": "2026-10-17T03:45:52.216188+00:00"
      }
    ],
    "total": 3,
    "truncated": false
  },
  "actor_inventory": {
    "items": [
      {
        "role": "admin",
        "user_id": "00000000-0000-4000-8000-000000000006",
        "updated_at": "2026-10-16T09:56:56.064053+00:00"
      }
    ],
    "total": 1,
    "truncated": false,
    "active_admin_count": 1,
    "active_fiscal_count": 0,
    "authenticated_actor_proven": false
  },
  "candidate_inventory": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000017",
        "model": "65",
        "state": "stored",
        "number": 4351,
        "series": 2,
        "version": 1,
        "a1_version": 1,
        "basis_hash": fixtureDigest("baseline.candidate_inventory.items[0].basis_hash"),
        "created_at": "2026-10-17T05:21:26.203867+00:00",
        "size_bytes": 6533,
        "finished_at": "2026-10-17T05:21:30.269434+00:00",
        "has_attempt": false,
        "signed_hash": fixtureDigest("baseline.candidate_inventory.items[0].signed_hash"),
        "reservation_id": "00000000-0000-4000-8000-000000000005",
        "source_document_id": "00000000-0000-4000-8000-000000000009"
      },
      {
        "id": "00000000-0000-4000-8000-000000000018",
        "model": "55",
        "state": "stored",
        "number": 42194,
        "series": 2,
        "version": 1,
        "a1_version": 1,
        "basis_hash": fixtureDigest("baseline.candidate_inventory.items[1].basis_hash"),
        "created_at": "2026-10-17T03:52:47.38398+00:00",
        "size_bytes": 6410,
        "finished_at": "2026-10-17T03:52:52.213045+00:00",
        "has_attempt": true,
        "signed_hash": fixtureDigest("baseline.candidate_inventory.items[1].signed_hash"),
        "reservation_id": "00000000-0000-4000-8000-000000000010",
        "source_document_id": "00000000-0000-4000-8000-000000000012"
      },
      {
        "id": "00000000-0000-4000-8000-000000000019",
        "model": "65",
        "state": "stored",
        "number": 4352,
        "series": 2,
        "version": 1,
        "a1_version": 1,
        "basis_hash": fixtureDigest("baseline.candidate_inventory.items[2].basis_hash"),
        "created_at": "2026-10-17T06:23:37.584077+00:00",
        "size_bytes": 6650,
        "finished_at": "2026-10-17T06:23:40.312247+00:00",
        "has_attempt": true,
        "signed_hash": fixtureDigest("baseline.candidate_inventory.items[2].signed_hash"),
        "reservation_id": "00000000-0000-4000-8000-000000000013",
        "source_document_id": "00000000-0000-4000-8000-000000000015"
      }
    ],
    "total": 3,
    "truncated": false,
    "eligibility_attested": false,
    "stored_without_attempt": 1
  },
  "historical_revalidations": {
    "items": [
      {
        "actor": "00000000-0000-4000-8000-000000000006",
        "cstat": "104",
        "outcome": "authorization_declared",
        "row_hash": fixtureDigest("baseline.historical_revalidations.items[0].row_hash"),
        "attempt_id": "00000000-0000-4000-8000-000000000020",
        "command_id": "00000000-0000-4000-8000-000000000021",
        "created_at": "2026-10-17T05:27:26.688457+00:00",
        "source_hash": fixtureDigest("baseline.historical_revalidations.items[0].source_hash"),
        "original_state": "review_required",
        "parser_profile": "authorization-stored-response-utf8-v1",
        "processed_hash": fixtureDigest("baseline.historical_revalidations.items[0].processed_hash"),
        "protocol_cstat": "100",
        "revalidated_state": "authorized_homologation"
      }
    ],
    "total": 1
  },
  "historical_authorizations": {
    "items": [
      {
        "actor": "00000000-0000-4000-8000-000000000006",
        "cstat": null,
        "model": "55",
        "state": "review_required",
        "used_at": "2026-10-17T04:40:13.813801+00:00",
        "attempt_id": "00000000-0000-4000-8000-000000000020",
        "command_id": "00000000-0000-4000-8000-000000000022",
        "finished_at": "2026-10-17T04:40:18.022972+00:00",
        "signed_hash": fixtureDigest("baseline.candidate_inventory.items[1].signed_hash"),
        "candidate_id": "00000000-0000-4000-8000-000000000018",
        "response_hash": fixtureDigest("baseline.historical_authorizations.items[0].response_hash"),
        "policy_version": 4,
        "processed_hash": null,
        "protocol_cstat": null,
        "rejection_code": "SOAP_INVALID",
        "result_outcome": "invalid_response",
        "result_row_hash": fixtureDigest("baseline.historical_authorizations.items[0].result_row_hash"),
        "attempt_row_hash": fixtureDigest("baseline.historical_authorizations.items[0].attempt_row_hash")
      },
      {
        "actor": "00000000-0000-4000-8000-000000000006",
        "cstat": "104",
        "model": "65",
        "state": "rejected",
        "used_at": "2026-10-17T06:24:23.986706+00:00",
        "attempt_id": "00000000-0000-4000-8000-000000000023",
        "command_id": "00000000-0000-4000-8000-000000000024",
        "finished_at": "2026-10-17T06:24:27.101304+00:00",
        "signed_hash": fixtureDigest("baseline.candidate_inventory.items[2].signed_hash"),
        "candidate_id": "00000000-0000-4000-8000-000000000019",
        "response_hash": fixtureDigest("baseline.historical_authorizations.items[1].response_hash"),
        "policy_version": 4,
        "processed_hash": null,
        "protocol_cstat": "245",
        "rejection_code": null,
        "result_outcome": "rejected",
        "result_row_hash": fixtureDigest("baseline.historical_authorizations.items[1].result_row_hash"),
        "attempt_row_hash": fixtureDigest("baseline.historical_authorizations.items[1].attempt_row_hash")
      }
    ],
    "total": 2
  },
  "authorization_policy_heads": [
    {
      "model": "55",
      "origin": "operational",
      "enabled": false,
      "version": 5,
      "created_at": "2026-10-17T04:40:52.279374+00:00",
      "valid_from": "2026-10-17T04:40:52.279031+00:00",
      "valid_until": "2026-10-26T03:00:00+00:00",
      "rule_profile": "sp-crt1-internal-sale-homologation-20261017-v2",
      "binding_profile": "sp55-authorization-soap12-reviewed-20261016-v1",
      "binding_reviewed": true,
      "tax_rules_reviewed": false,
      "source_manifest_hash": "e70502bf2fa3a720dcd1eb7abf689d90cf61b192e01cdd182cbba816057e4f9b",
      "authorization_profile": "reviewed_subset_v1"
    },
    {
      "model": "65",
      "origin": "operational",
      "enabled": false,
      "version": 5,
      "created_at": "2026-10-17T06:24:51.98273+00:00",
      "valid_from": "2026-10-17T06:24:51.982367+00:00",
      "valid_until": "2026-10-26T03:00:00+00:00",
      "rule_profile": "sp-crt1-internal-sale-homologation-20261017-v2",
      "binding_profile": "sp65-authorization-soap12-reviewed-20261016-v1",
      "binding_reviewed": true,
      "tax_rules_reviewed": false,
      "source_manifest_hash": "b4ddf9d9fff3a9efff05d6cc97e9904835314455ab730ee4cc8ba0c9e13b07f7",
      "authorization_profile": "reviewed_subset_v1"
    }
  ],
  "receipt_query_policy_heads": [
    {
      "model": "55",
      "origin": "operational",
      "enabled": false,
      "profile": "receipt-query-source-089-v1",
      "version": 1,
      "created_at": "2026-10-17T10:24:16.326857+00:00",
      "valid_from": "2026-10-17T00:00:00+00:00",
      "valid_until": "2026-10-18T00:00:00+00:00",
      "lease_seconds": 60,
      "manifest_hash": "748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098",
      "binding_profile": "sp55-receipt-soap12-reviewed-20261016-v1",
      "cadence_seconds": 60,
      "max_queries_per_hour": 10
    },
    {
      "model": "65",
      "origin": "operational",
      "enabled": false,
      "profile": "receipt-query-source-089-v1",
      "version": 1,
      "created_at": "2026-10-17T10:24:16.327115+00:00",
      "valid_from": "2026-10-17T00:00:00+00:00",
      "valid_until": "2026-10-18T00:00:00+00:00",
      "lease_seconds": 60,
      "manifest_hash": "748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098",
      "binding_profile": "sp65-receipt-soap12-reviewed-20261016-v1",
      "cadence_seconds": 60,
      "max_queries_per_hour": 10
    }
  ]
};
export const windowBaselineFixture=()=>structuredClone(baseline);
