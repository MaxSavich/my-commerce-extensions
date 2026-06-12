# Capstone — Badge backend (`capstone-badges` package)

Runtime actions powering the PDP Badge System. Namespace
`3967933-682ghostwhiteloon-stage`, package `capstone-badges`.

## Badge rules (final)
| Badge | Type key | Condition |
|-------|----------|-----------|
| New | `new` | product `created_at` within `newWithinDays` (default 30) |
| Best Seller | `bestseller` | `sku` in merchant-configured `bestsellerSkus[]` |
| Limited Offer | `limited` | active `special_price` within `special_from_date`/`special_to_date` |

Rules live in I/O State key `badge-rules` (overridable via the Week 5 Admin UI).
If absent, `DEFAULT_RULES` is used: `{ newWithinDays: 30, bestsellerSkus: ["BPG-5005"] }`.
Catalog-price-rule discounts are out of scope (only `special_price`).

## Actions

### `compute-badges` (web, POST/GET)
Input: `sku` (+ IMS S2S creds, `COMMERCE_API_BASE_URL`, `COMMERCE_STORE_CODE` via action inputs).
Flow: IMS token -> `GET /V1/products/{sku}` -> load `badge-rules` -> apply rules -> `state.put('badge_<sku>')` (TTL 30d).
Returns: `{ sku, badges: string[], updatedAt }`.
URL: `https://3967933-682ghostwhiteloon-stage.adobeioruntime.net/api/v1/web/capstone-badges/compute-badges?sku=<sku>`

### `get-badges` (web, GET)
Input: `sku`. Reads `badge_<sku>` from I/O State. Returns `{ sku, badges, updatedAt }`
(empty list if not yet computed). Fast read; no Commerce call. Exposed through API
Mesh as `Badges_getProductBadges(sku)`.
URL: `https://3967933-682ghostwhiteloon-stage.adobeioruntime.net/api/v1/web/capstone-badges/get-badges?sku=<sku>`

## State keys
- `badge_<sku>` -> `{ sku, badges, updatedAt }` (TTL 30d, refreshed on each compute)
- `badge-rules` -> `{ newWithinDays, bestsellerSkus }` (merchant config; Week 5)

## Mesh
`get-badges` is wrapped by `badges-openapi.json` and added to `mesh.json` as source
`Badges` (prefix `Badges_`). Storefront queries
`Badges_getProductBadges(sku) { sku badges updatedAt }` at the sandbox graph endpoint.

## Errors
- 400 missing `sku` / `COMMERCE_API_BASE_URL`
- Commerce API non-200 is passed through with the upstream status
- 500 unexpected (detail in body)

## Recompute trigger
Week 4 adds `badge-event-consumer` (I/O Events on `catalog_product_save_after`) which
calls `compute-badges` over HTTP whenever a product is saved.
