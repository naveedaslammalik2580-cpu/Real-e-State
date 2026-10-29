    // Boot the application with graceful failure handling
    document.addEventListener('DOMContentLoaded', function () {
      Promise.resolve(App.app.init()).catch(function (err) {
        console.error('Init failed:', err);
        document.getElementById('root').innerHTML =
          '<div style="padding:40px;max-width:620px;margin:40px auto;font-family:var(--font-primary);">' +
          '<h1 style="color:var(--text-strong);font-size:var(--font-size-xl);margin-bottom:12px;">Project could not finish starting</h1>' +
          '<p style="color:var(--text-muted);line-height:1.6;">Your account data is safe — nothing has been reset. Check your internet connection and refresh. If the problem continues, try a current version of Chrome or Microsoft Edge.</p>' +
          '<p style="color:var(--text-soft);font-size:var(--font-size-sm);margin-top:12px;">' + (err && err.message ? App.util.esc(err.message) : '') + '</p></div>';
      });
    });
  