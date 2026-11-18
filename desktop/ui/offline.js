// Shown while the chat can't be loaded; the app tries again by itself.
const why = new URLSearchParams(location.search).get('reason');
if (why) document.getElementById('why').textContent = '(' + why + ')';
