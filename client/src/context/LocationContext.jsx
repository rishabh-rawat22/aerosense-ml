import React, { createContext, useContext, useState, useCallback } from 'react';

const LocationContext = createContext(null);

export const LocationProvider = ({ children }) => {
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [coords,           setCoords]           = useState(null);
  const [locationError,    setLocationError]    = useState(null);
  const [locating,         setLocating]         = useState(false);

  const requestGeolocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported. Please select a district manually.');
      return;
    }
    setLocating(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      ({ coords: c }) => {
        setCoords({ lat: c.latitude, lon: c.longitude });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        const msgs = {
          1: 'Location access denied. Please select your district manually.',
          2: 'Location unavailable. Please select your district manually.',
          3: 'Location request timed out. Please select your district manually.',
        };
        setLocationError(msgs[err.code] || 'Unable to detect location. Please select manually.');
      },
      { timeout: 8000, maximumAge: 300000 }
    );
  }, []);

  const selectDistrict = useCallback((district) => {
    setSelectedDistrict(district);
    setCoords(null);
    setLocationError(null);
  }, []);

  const getLocationParams = useCallback(() => {
    if (selectedDistrict) return { district: selectedDistrict };
    if (coords)           return { lat: coords.lat, lon: coords.lon };
    return null;
  }, [selectedDistrict, coords]);

  return (
    <LocationContext.Provider value={{ selectedDistrict, coords, locationError, locating, requestGeolocation, selectDistrict, getLocationParams }}>
      {children}
    </LocationContext.Provider>
  );
};

export const useLocation = () => {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocation must be used within LocationProvider');
  return ctx;
};
