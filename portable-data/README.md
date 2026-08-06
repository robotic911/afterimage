# Afterimage Portable Data

This directory is intentionally version-controlled. It contains portable app configuration, template/event assets, and scrubbed business records exported from Electron userData.

Do not place `.env` files, Supabase service role keys, generated customer media, Downloads output, cache files, or machine-specific printer/camera settings here.

Use `npm run data:export` on the source laptop and `npm run data:import` on the destination laptop.
