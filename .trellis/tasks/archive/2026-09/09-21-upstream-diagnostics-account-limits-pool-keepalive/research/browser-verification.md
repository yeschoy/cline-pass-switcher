# Parent cross-feature browser smoke (2026-09-23)

Scope: real Google Chrome (`--headless=new`), isolated profile, CDP trusted mouse/keyboard input, 375 CSS-pixel viewport, local switcher `DATA_DIR=/tmp/cps-parent-ui` with two fake saved accounts (`maxRpm=5`, min=2/max=3/low=1), no production credentials, no paid/live upstream. An initial fixture without a cached `/models` catalog prevented `loadAll()` from rendering rows; adding a fresh synthetic catalog in the temporary metadata and reloading resolved this fixture error.

Results: **5/5** checks passed.

1. 375px viewport: `documentElement.scrollWidth=375`; pool runtime text includes target 2 / low 1 / actual unknown 2, without treating unknown as numeric quota zero. Native account drawer label describes `maxRpm`.
2. Trusted click on the saved account's "设置" opens the drawer with focus at `#drawerName` and `#drawerRpm.value=5`.
3. Trusted keyboard input changes only the local RPM draft to 7 with `activeElement.id=drawerRpm`; restoring it to 5 and sending Escape closes a clean drawer and returns focus to the opening settings button.
4. Trusted click on `#navDetails`, then `#errorDetailLogging` writes the default-off error-detail switch to the local `GET /api/logs/settings` API (`false→true`). `#detailsStatus[aria-live=polite]` announces “日志设置已保存；账号草稿未改变”; copy remains disabled before any body is loaded.
5. Narrow-screen detailed panel screenshot `/tmp/cps-parent-ui/details-375.png` was visually inspected: labelled native controls remain readable; no whole-document horizontal overflow.

No product code changed during this smoke. It does **not** prove clipboard behavior, an authenticated operator session, real New API/Cline behavior, or desktop browser layout. Screenshot and temporary profile remain outside the repository, pending operator-approved cleanup; Trellis task evidence is this text record.
