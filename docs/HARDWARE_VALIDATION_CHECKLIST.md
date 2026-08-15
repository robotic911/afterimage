# Afterimage Hardware Validation Checklist

Use this checklist when testing the packaged booth on the real hardware setup.

## 1. Packaged App Test

- [ ] Install the Windows package from `release/Afterimage Setup *.exe`
- [ ] Or run the portable Windows build from `release/Afterimage Portable *.exe`
- [ ] Confirm the main customer window opens
- [ ] Confirm Today Monitor opens
- [ ] Confirm Admin opens
- [ ] Confirm no missing asset errors appear on startup

## 2. Camera Test With Insta360

- [ ] Camera is detected
- [ ] 1080p preview is used if available
- [ ] Live preview works
- [ ] Countdown works
- [ ] Capture completes successfully
- [ ] Preview does not stretch or distort
- [ ] All layouts are tested with the camera

Notes:

- Record which camera model was connected.
- Record whether 4K was available in this booth build.

## 3. Print Test With Canon SELPHY

- [ ] Print 1 copy
- [ ] Print 2 copies
- [ ] Print 3 copies
- [ ] Verify print margins
- [ ] Verify brightness / compensation
- [ ] Verify copy count matches the selection
- [ ] Verify queue status updates correctly

Notes:

- Record paper type used.
- Record printer profile selected in Admin.

## 4. Print Queue Test

- [ ] Complete a print job
- [ ] Trigger a print failure if possible
- [ ] Cancel a 3-copy print during the first copy
- [ ] Delete a completed queue item
- [ ] Clear completed jobs

Expected:

- Completed jobs show `Completed`
- Failed jobs show `Failed`
- Cancelled jobs show `Cancelled`
- Partial jobs show `Partial`

## 5. QR Softcopy Matrix

Test each configuration below:

- [ ] QR off
- [ ] Photo only
- [ ] GIF only
- [ ] Video only
- [ ] Photo + GIF
- [ ] Photo + Video
- [ ] Photo + GIF + Video

For each configuration:

- [ ] Scan the QR code
- [ ] Verify only enabled media appears
- [ ] Verify download works
- [ ] Verify video preview works only when video exists

Notes:

- Confirm QR-disabled sessions do not show QR UI.
- Confirm missing media is hidden cleanly on the softcopy page.

## 6. Supabase Cleanup Test

- [ ] Create a QR session
- [ ] Manually expire the cleanup row or test record
- [ ] Run the cleanup process
- [ ] Confirm photo files are deleted
- [ ] Confirm GIF files are deleted
- [ ] Confirm video files are deleted
- [ ] Confirm the database row is removed or marked deleted according to current behavior

Notes:

- Record whether cleanup is hard-delete or soft-delete in the current build.

## 7. Error Recovery Test

- [ ] Simulate printer unavailable
- [ ] Simulate QR upload / network failure
- [ ] Simulate camera unavailable
- [ ] Simulate GIF generation failure if possible
- [ ] Simulate video generation failure if possible
- [ ] Confirm retry buttons work
- [ ] Confirm End Session still works

Expected:

- Print failure shows `Retry Print`
- Upload failure shows `Retry Upload`
- Camera failure shows `Retry Camera`

## 8. Today Monitor Test

- [ ] Click Refresh
- [ ] Press `F5`
- [ ] Press `Cmd+R` or `Ctrl+R`
- [ ] Confirm quick settings sync with the main app
- [ ] Confirm a completed session appears
- [ ] Confirm print queue updates
- [ ] Confirm the window scrolls correctly at small sizes

Notes:

- Refresh should not reset the current booth session.

## 9. Admin Settings Test

- [ ] QR toggles persist
- [ ] Photo / GIF / Video toggles persist
- [ ] Layout enable / disable persists
- [ ] Template enable / disable persists
- [ ] Countdown persists
- [ ] Test Mode persists if enabled

Notes:

- Confirm false values remain false after restart.
- Confirm Today Monitor reflects changes without restart.

## 10. Final Event Readiness Checklist

- [ ] Camera ready
- [ ] Printer ready
- [ ] Paper / ink ready
- [ ] QR tested
- [ ] Test print completed
- [ ] Event mode / daily mode confirmed
- [ ] Templates enabled as expected
- [ ] Storage / egress checked
- [ ] Test Mode status confirmed

## Post-Test Notes

- Date:
- Venue:
- Booth operator:
- Camera:
- Printer:
- Network:
- Issues found:
- Follow-up items:
