import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user,    setUser]    = useState(null);
  const [token,   setToken]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem('aerosense_token');
    const u = localStorage.getItem('aerosense_user');
    if (t && u) { setToken(t); setUser(JSON.parse(u)); }
    setLoading(false);
  }, []);

  const persist = (token, user) => {
    localStorage.setItem('aerosense_token', token);
    localStorage.setItem('aerosense_user', JSON.stringify(user));
    setToken(token);
    setUser(user);
  };

  const login = async (email, password) => {
    const { data } = await authAPI.login({ email, password });
    persist(data.token, data.user);
    return data.user;
  };

  const register = async (name, email, password) => {
    const { data } = await authAPI.register({ name, email, password });
    persist(data.token, data.user);
    return data.user;
  };

  const logout = useCallback(() => {
    localStorage.removeItem('aerosense_token');
    localStorage.removeItem('aerosense_user');
    setToken(null);
    setUser(null);
  }, []);

  const updateLastDistrict = async (district) => {
    try {
      await authAPI.updateDistrict(district);
      const updated = { ...user, lastKnownDistrict: district };
      setUser(updated);
      localStorage.setItem('aerosense_user', JSON.stringify(updated));
    } catch (_) {}
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, updateLastDistrict }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
