/* LEGION — página de download do loader INTERNAL */
(() => {
  'use strict';

  const FILES = [
    { name: 'winsys.exe', url: '/download/winsys.exe' },
    { name: 'ZmInternal.dll', url: '/download/ZmInternal.dll' },
  ];

  const button = document.getElementById('pickFolderBtn');
  const status = document.getElementById('downloadStatus');
  const progress = document.getElementById('downloadProgress');
  const bar = document.getElementById('downloadBar');
  const year = document.getElementById('year');

  if (year) year.textContent = String(new Date().getFullYear());

  const supportsFolder = typeof window.showDirectoryPicker === 'function';

  function setStatus(text, kind = '') {
    if (!status) return;
    status.textContent = text;
    status.className = `download-hint${kind ? ` is-${kind}` : ''}`;
  }

  if (!supportsFolder && button) {
    button.disabled = true;
    button.textContent = 'Use o .zip neste navegador';
    setStatus('Este navegador não permite escolher a pasta. Baixe o .zip e extraia onde quiser.');
  }

  if (button) {
    button.addEventListener('click', async () => {
      if (!supportsFolder) return;

      try {
        const directory = await window.showDirectoryPicker({
          id: 'legion-internal-loader',
          mode: 'readwrite',
          startIn: 'downloads',
        });

        if (progress) progress.hidden = false;
        if (bar) bar.style.width = '0%';

        let done = 0;
        for (const file of FILES) {
          setStatus(`Baixando ${file.name}...`);
          const response = await fetch(file.url, { cache: 'no-store' });
          if (!response.ok) throw new Error(`falha ao baixar ${file.name}`);

          const blob = await response.blob();
          const handle = await directory.getFileHandle(file.name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();

          done += 1;
          if (bar) bar.style.width = `${Math.round((done / FILES.length) * 100)}%`;
        }

        setStatus('Pronto. winsys.exe e ZmInternal.dll foram salvos na pasta escolhida.', 'ok');
        if (button) {
          button.textContent = 'Baixado — escolher outra pasta';
        }
      } catch (error) {
        if (error && error.name === 'AbortError') {
          setStatus('Download cancelado.');
          return;
        }
        setStatus(`Não foi possível salvar: ${error.message}`, 'error');
      }
    });
  }
})();
