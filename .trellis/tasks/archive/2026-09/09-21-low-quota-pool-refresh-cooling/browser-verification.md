# Browser Verification — Low-Quota Pool Controls

## Environment

- Real Google Chrome (headless) driven via CDP `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`; Node built-in WebSocket, no project dependency or production data.
- Local isolated switcher: temporary `DATA_DIR=/tmp/cps-low-ui`, localhost port 3412, two mock accounts; sticky mode, min=2, max=3, low=1, no live upstream.
- Narrow viewport: **375 CSS pixels**. Screenshots are temporary at `/tmp/cps-low-ui/375.png` and `/tmp/cps-low-ui/375-controls.png` (not committed). The controls screenshot was visually inspected.

## Observed Results (6/6)

1. Native `<label for="cachePoolLowQuotaSize">` resolves to a visible `type=number` control with `min=0`, `max=100000`, `step=1` and `aria-describedby="cachePoolHelp"`.
2. `document.documentElement.scrollWidth === innerWidth === 375`; the numeric controls wrap; `#cachePoolRuntime` does not overflow its container. The account table has its own scroll wrapper.
3. At low=1, runtime text truthfully shows target=2, min=2, max=3, low target=1 and actual high=0/low=0/unknown=2; unknown is not displayed as numeric quota zero.
4. Trusted keyboard input changed the focused low draft to 3 while min=2.
5. Real Enter on “保存账号配置” rejected the cross-field draft with `#accMsg` announcing `低额度槽数不得大于最小账号数`; the authenticated `/api/accounts` snapshot still reported low=1 (no persistence).
6. Trusted keyboard input changed the draft to explicit low=0; real Enter saved successfully; `/api/accounts.accountPipeline.cachePoolLowQuotaSize===0`, `#cachePoolRuntime` displayed `低额度槽 0` and `#accMsg` announced two accounts saved.

The first CDP harness attempt omitted a `char` event for Enter and therefore did not activate the save button. The corrected trusted key sequence (rawKeyDown → char → keyUp) passed; this was a harness issue, not a product defect. No production code was changed during browser verification.
