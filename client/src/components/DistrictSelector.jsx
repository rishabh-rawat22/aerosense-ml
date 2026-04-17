import React, { useState, useEffect, useRef, useCallback } from 'react';
import { aqiAPI } from '../api';
import { useLocation } from '../context/LocationContext';

const DistrictSelector = ({ onSelect }) => {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const { selectedDistrict, selectDistrict, requestGeolocation, locating, locationError } = useLocation();
  const debounceRef  = useRef(null);
  const dropdownRef  = useRef(null);

  const fetchDistricts = useCallback(async (q) => {
    setLoading(true);
    try {
      const { data } = await aqiAPI.getDistricts(q);
      setResults(data.data || []);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.length >= 1) debounceRef.current = setTimeout(() => fetchDistricts(query), 300);
    else setResults([]);
    return () => clearTimeout(debounceRef.current);
  }, [query, fetchDistricts]);

  useEffect(() => {
    const close = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const handleSelect = (d) => {
    selectDistrict(d.name);
    setQuery(d.name);
    setOpen(false);
    if (onSelect) onSelect(d.name);
  };

  return (
    <div className="district-selector" ref={dropdownRef}>
      <div className="selector-row">
        <div className="search-wrapper">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Search city or district..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => query.length >= 1 && setOpen(true)}
          />
          {loading && <span className="search-spinner">⏳</span>}
          {query && <button className="clear-btn" onClick={() => { setQuery(''); setResults([]); setOpen(false); }}>✕</button>}
        </div>

        <button className={`locate-btn ${locating ? 'locating' : ''}`} onClick={() => { setQuery(''); requestGeolocation(); }} disabled={locating}>
          {locating ? '📡' : '📍'} <span>{locating ? 'Locating...' : 'My Location'}</span>
        </button>
      </div>

      {locationError && <div className="location-error"><span>⚠️</span> {locationError}</div>}

      {selectedDistrict && !open && (
        <div className="selected-badge">
          <span>📍</span>
          <span>Viewing: <strong>{selectedDistrict}</strong></span>
          <button className="change-btn" onClick={() => { setQuery(''); setOpen(false); selectDistrict(''); }}>Change</button>
        </div>
      )}

      {open && results.length > 0 && (
        <ul className="dropdown-list">
          {results.map((d, i) => (
            <li key={i} className="dropdown-item" onClick={() => handleSelect(d)}>
              <span className="district-name">{d.name}</span>
              <div className="district-meta">
                <span className="district-state">{d.state}</span>
                {d.stations && <span className="district-stations">{d.stations} station{d.stations > 1 ? 's' : ''}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && query.length >= 1 && !loading && results.length === 0 && (
        <div className="dropdown-empty">No districts found for "{query}"</div>
      )}
    </div>
  );
};

export default DistrictSelector;
