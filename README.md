# STK Push Backend (Daraja)

Plain `node:http` server, zero npm dependencies.

## Env vars

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `MPESA_CONSUMER_KEY` | yes (live) | — | Daraja app key |
| `MPESA_CONSUMER_SECRET` | yes (live) | — | Daraja app secret |
| `MPESA_PASSKEY` | yes (live) | — | STK passkey |
| `MPESA_SHORTCODE` | yes (live) | — | Business shortcode (Paybill 615395) |
| `MPESA_ENV` | no | `sandbox` | `sandbox` \| `production` |
| `MPESA_TYPE` | no | `CustomerPayBillOnline` | Paybill STK type |
| `PUBLIC_URL` | no | — | Public base URL, used for the callback URL |
| `PORT` | no | `3003` | Listen port |

## Daraja callback URL

In the Daraja dashboard / app settings, set the Online/STK callback URL to:

```
PUBLIC_URL/api/pay/callback
```

## Run

```sh
PORT=3003 node server/stk.js
```

## Demo mode

When any of `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, or
`MPESA_SHORTCODE` is absent, `POST /api/pay` returns `501` with a simulated
`CheckoutRequestID` (`DEMO-…`, `demo:true`) and the message
`STK not configured — use Paybill 615395`. The callback endpoint still records
entries to `data/payments.log` and returns `Accepted`.
