const EDGE_FUNCTION_URL =
  'https://byzeayfrbhqzsbgewaqi.functions.supabase.co/softcopy-page';

const loadingEl = document.getElementById('loading');
const readyEl = document.getElementById('ready');
const errorEl = document.getElementById('error');
const errorMessageEl = document.getElementById('errorMessage');

const photoPreviewEl = document.getElementById('photoPreview');
const photoLinkEl = document.getElementById('photoLink');
const gifLinkEl = document.getElementById('gifLink');
const noMediaMessageEl = document.getElementById('noMediaMessage');
const videoSectionEl = document.getElementById('videoSection');
const videoPreviewEl = document.getElementById('videoPreview');
const videoLinkEl = document.getElementById('videoLink');

function showState(state) {
  loadingEl.classList.add('hidden');
  readyEl.classList.add('hidden');
  errorEl.classList.add('hidden');

  if (state === 'loading') loadingEl.classList.remove('hidden');
  if (state === 'ready') readyEl.classList.remove('hidden');
  if (state === 'error') errorEl.classList.remove('hidden');
}

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

async function loadSoftcopies() {
  showState('loading');

  const token = getToken();

  if (!token) {
    errorMessageEl.textContent = 'Missing softcopy token.';
    showState('error');
    return;
  }

  try {
    const response = await fetch(`${EDGE_FUNCTION_URL}?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      const message =
        data.error === 'expired'
          ? 'This download link has expired.'
          : data.message || 'This softcopy link is invalid or unavailable.';

      errorMessageEl.textContent = message;
      showState('error');
      return;
    }

    const hasPhoto = Boolean(data.photoUrl);
    const hasGif = Boolean(data.gifUrl);
    const hasVideo = Boolean(data.videoUrl);

    if (hasPhoto) {
      photoPreviewEl.src = data.photoUrl;
      photoPreviewEl.closest('.preview-wrap')?.classList.remove('hidden');
      photoLinkEl.href = data.photoUrl;
      photoLinkEl.classList.remove('hidden');
    } else {
      photoPreviewEl.removeAttribute('src');
      photoPreviewEl.closest('.preview-wrap')?.classList.add('hidden');
      photoLinkEl.href = '#';
      photoLinkEl.classList.add('hidden');
    }

    if (hasGif) {
      gifLinkEl.href = data.gifUrl;
      gifLinkEl.classList.remove('hidden');
    } else {
      gifLinkEl.href = '#';
      gifLinkEl.classList.add('hidden');
    }

    if (data.videoUrl) {
      videoPreviewEl.preload = 'metadata';
      videoPreviewEl.autoplay = false;
      videoPreviewEl.muted = true;
      if (data.photoUrl) videoPreviewEl.poster = data.photoUrl;
      videoPreviewEl.src = data.videoUrl;
      if (data.videoMimeType) videoPreviewEl.type = data.videoMimeType;
      videoLinkEl.href = data.videoUrl;
      videoSectionEl.classList.remove('hidden');
    } else {
      videoPreviewEl.removeAttribute('src');
      videoLinkEl.href = '#';
      videoSectionEl.classList.add('hidden');
    }

    noMediaMessageEl.classList.toggle('hidden', hasPhoto || hasGif || hasVideo);

    showState('ready');
  } catch (error) {
    console.error('[Afterimage Softcopy] Failed to load:', error);
    errorMessageEl.textContent = 'Unable to load softcopies. Please try again later.';
    showState('error');
  }
}

loadSoftcopies();
