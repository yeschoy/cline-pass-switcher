# Real-browser validation

Date: 2026-09-16
Browser: Google Chrome 152, isolated temporary profile and temporary `DATA_DIR`
Traffic: local mock upstream and fake account keys only; no production data or credentials

## Passed

- Production page loaded at 1200px and hydrated the persisted default order.
- Activating the native “上移 Cline 额度热池” button with Enter moved `quotaPool` to position 1.
- Because its up button became disabled at the first position, logical focus moved to the same row's enabled “下移 Cline 额度热池” button.
- Chrome `DragEvent`/`DataTransfer` execution moved `sticky` to position 1 and announced the new position as an unsaved draft.
- At a 500px viewport, document width remained 485px and every pipeline row stayed within the viewport.
- Explicit account save persisted the reordered four-step permutation through `/api/accounts`; the subsequent hydration restored it and cleared the unsaved-order status.

## Boundaries

- A first raw CDP mouse-movement sequence ended as a cancelled drag because it did not produce a complete native HTML5 DataTransfer/drop lifecycle. Production handler wiring was then exercised with Chrome's real `DragEvent` and `DataTransfer` objects; VM tests independently cover handler inputs and insertion halves.
- Screen-reader audio was not tested. Native button labels, position labels and the `aria-live` status are covered by browser state/static tests.
- All browser data and processes used temporary local paths and were removed after validation.
