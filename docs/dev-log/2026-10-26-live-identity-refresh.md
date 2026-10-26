# 2026-10-26 Live identity refresh

- Production collector lost login facts after SPA navigation although the saved session still returned a valid identity. Re-read only the already observed HTTPS identity URL and current page account controls after navigation.
- Pin responses to the request's navigation generation; ignore stale responses and foreign hosts. Clear room state on creator or executor changes. Failed refresh leaves identity unavailable.
- This patch restores read-only collection identity; it does not verify sending permissions or enable replies. Production validation and the business deployment record are maintained in the integration repository.
- Synthetic tests cover navigation recovery, late responses, foreign hosts, executor switch and failed refresh.
