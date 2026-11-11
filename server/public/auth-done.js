// The desktop client reads the token from this page's address and closes the
// window itself. In a plain browser, hand the token to the web client instead.
(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token || window.isleDesktop) return;
  try {
    const info = await (await fetch('/api/info')).json();
    if (info.webClient) {
      sessionStorage.setItem('isleVoipToken', token);
      location.replace('/play/');
    }
  } catch {}
})();
