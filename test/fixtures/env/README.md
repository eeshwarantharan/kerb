# Environment classifier fixtures (KERB-V2 8.3)

- `tls/`: TLS interception errors as each tool prints them.
- `proxy/<id>.txt`: one capture per proxy block-page signature in `src/insight/envclass.js`
  (`PROXY_PAGES`). A signature may only be added together with a real capture here (test EN6).
  `squid-access-denied.txt` is Squid's stock `ERR_ACCESS_DENIED` template (from the Squid source,
  `errors/templates/ERR_ACCESS_DENIED`) with the URL filled in.
- `generic-403.txt`: an ordinary 403 page that must not be classified.
- `corp-root-ca.pem`: a throwaway self-signed CA certificate (no key kept) for `kerb doctor tls`.
