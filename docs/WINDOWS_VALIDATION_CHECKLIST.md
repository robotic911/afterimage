# Afterimage Windows Validation

## Package And Startup

- Run `npm run pack -- --win`.
- Confirm `release/win-unpacked/Afterimage.exe` starts.
- Confirm the NSIS installer builds with `npm run dist:win`.
- Install and restart Afterimage.
- Confirm Admin and Today Monitor open normally.

## Persistent Data

- Confirm `%APPDATA%\Afterimage` contains runtime data.
- Confirm templates persist in `%APPDATA%\Afterimage\templates`.
- Confirm `settings.json`, `sessions.jsonl`, and template edits survive restart.
- Confirm assets load through `kuku-template://` after restart.

## Camera

- Allow camera access in Windows Settings under Privacy & security > Camera.
- Enable camera access for desktop apps.
- Confirm the intended camera is selected and reconnect recovery works.
- Confirm capture resolution, framing, and saved-photo quality are unchanged.

## Canon SELPHY CP1500

- Install the current Canon Windows driver.
- Confirm the printer appears in Settings > Bluetooth & devices > Printers & scanners.
- Set the SELPHY as the Windows default printer before kiosk use.
- Set the driver paper size to 4x6 and disable driver-side fit or scaling where available.
- Print the calibration guide and verify margins, top dead-cut compensation, orientation, and color.
- Confirm multiple copies, app-level cancellation, failure recovery, and the Windows print queue.

## Templates And Softcopy

- Create, edit, replace, and delete a runtime template.
- Confirm customer template selection and final receipt rendering.
- Confirm Supabase photo, GIF, and video uploads.
- Confirm QR links open from a separate phone.
- Confirm Retry Upload does not reprint.

## Release Sign-Off

- Test on the actual Windows laptop, camera, SELPHY driver, paper, and network intended for deployment.
- Record the Windows version, Electron build, printer driver version, and final calibration values.
