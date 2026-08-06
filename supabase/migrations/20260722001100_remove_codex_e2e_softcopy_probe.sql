-- Remove the disposable production verification row created after
-- 20260722001000_fix_create_softcopy_session_ambiguity.sql was deployed.

delete from public.softcopy_sessions
where session_token = 'codex-e2e-1784707035782'
  and photo_path = 'sessions/codex-e2e-1784707035782/photo.jpg'
  and gif_path = 'sessions/codex-e2e-1784707035782/animation.gif'
  and video_path = 'sessions/codex-e2e-1784707035782/video.mp4';
