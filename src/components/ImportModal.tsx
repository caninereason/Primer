import { useState, useRef, useCallback } from 'react';

interface ImportModalProps {
  onImport: (data: string) => void;
  onClose: () => void;
  error?: string;
}

export function ImportModal({ onImport, onClose, error }: ImportModalProps) {
  const [url, setUrl] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = e => {
        const content = e.target?.result as string;
        if (content) onImport(content);
      };
      reader.readAsText(file);
    },
    [onImport],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleUrlImport = () => {
    if (!url.trim()) return;
    onImport(url.trim());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import iReal Pro Playlist</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div
            className={`drop-zone ${isDragging ? 'dragging' : ''}`}
            onDragOver={e => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
          >
            <div className="drop-icon">&#128194;</div>
            <p>Drop an iReal Pro HTML file here</p>
            <p className="drop-hint">or click to browse</p>
            <input
              ref={fileRef}
              type="file"
              accept=".html,.htm"
              style={{ display: 'none' }}
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>

          <div className="import-divider">
            <span>or paste a URL</span>
          </div>

          <div className="url-input-group">
            <input
              type="text"
              className="url-input"
              placeholder="irealbook://..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUrlImport()}
            />
            <button className="btn btn-primary" onClick={handleUrlImport}>
              Import
            </button>
          </div>

          {error && <p className="import-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
