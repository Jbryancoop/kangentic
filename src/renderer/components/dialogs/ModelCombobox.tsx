import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';

interface ModelComboboxProps {
  value: string;
  onChange: (value: string) => void;
  availableModels: string[];
  placeholder?: string;
  className?: string;
  testId?: string;
}

export function ModelCombobox({
  value,
  onChange,
  availableModels,
  placeholder = 'Default',
  className = '',
  testId = 'model-combobox',
}: ModelComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayValue = value || '';
  const searchQuery = filterText.toLowerCase();

  const filteredModels = availableModels.filter(
    (model) => model.toLowerCase().includes(searchQuery)
  );

  const showSuggestions = isOpen && availableModels.length > 0;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setFilterText('');
      }
    };

    if (isOpen) {
      // Capture phase: BaseDialog stops mousedown propagation on its content
      // wrapper, so a bubble-phase document listener never fires for clicks
      // inside the dialog. Capturing the event before it reaches the dialog
      // wrapper lets us close the menu when the user clicks any other field
      // in the same dialog.
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }
  }, [isOpen]);

  const handleInputChange = (newValue: string) => {
    onChange(newValue);
    setFilterText(newValue);
    setIsOpen(true);
  };

  const handleSelectModel = (model: string) => {
    onChange(model);
    setFilterText('');
    setIsOpen(false);
    // Do NOT refocus the input here - handleInputFocus auto-reopens the
    // dropdown when models are available, which would cancel the close.
    // The user has made their choice; let focus settle wherever the click
    // landed.
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setFilterText('');
    inputRef.current?.focus();
  };

  const handleToggleDropdown = () => {
    if (isOpen) {
      setIsOpen(false);
      setFilterText('');
    } else {
      setIsOpen(true);
      inputRef.current?.focus();
    }
  };

  const handleInputFocus = () => {
    if (availableModels.length > 0) {
      setIsOpen(true);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'Enter') {
      // Accept typed value and close dropdown
      setIsOpen(false);
      setFilterText('');
    } else if (e.key === 'ArrowDown' && showSuggestions && filteredModels.length > 0) {
      inputRef.current?.blur();
      (containerRef.current?.querySelector('[data-model-option]') as HTMLButtonElement)?.focus();
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="flex items-center gap-0 border border-edge-input rounded bg-surface">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={handleInputFocus}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          className="flex-1 bg-transparent px-3 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none"
        />
        {displayValue && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1 text-fg-faint hover:text-fg-muted transition-colors flex-shrink-0"
            title="Clear"
            aria-label="Clear"
          >
            <X size={16} />
          </button>
        )}
        {availableModels.length > 0 && (
          <button
            type="button"
            onClick={handleToggleDropdown}
            className="p-1.5 text-fg-muted hover:text-fg transition-colors flex-shrink-0 border-l border-edge-input"
            title={isOpen ? 'Close dropdown' : 'Open dropdown'}
            aria-label={isOpen ? 'Close dropdown' : 'Open dropdown'}
          >
            <ChevronDown
              size={16}
              className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-raised border border-edge rounded shadow-lg z-50 max-h-48 overflow-y-auto">
          {filteredModels.length > 0 ? (
            <div className="py-1">
              {filteredModels.map((model) => (
                <button
                  key={model}
                  type="button"
                  data-model-option
                  onClick={() => handleSelectModel(model)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      const next = e.currentTarget.nextElementSibling as HTMLButtonElement;
                      next?.focus();
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      const prev = e.currentTarget.previousElementSibling as HTMLButtonElement;
                      if (prev) {
                        prev.focus();
                      } else {
                        inputRef.current?.focus();
                      }
                    } else if (e.key === 'Enter') {
                      handleSelectModel(model);
                    }
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition-colors"
                >
                  {model}
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-xs text-fg-faint text-center">
              No models match "{filterText}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
