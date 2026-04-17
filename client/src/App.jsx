import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth }  from './context/AuthContext';
import { LocationProvider }       from './context/LocationContext';
import AuthForm  from './components/AuthForm';
import Dashboard from './components/Dashboard';
import './index.css';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="full-loading"><div className="loading-orb" /><p>Loading Aerosense...</p></div>;
  return user ? children : <Navigate to="/login" replace />;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return null;
  return !user ? children : <Navigate to="/dashboard" replace />;
};

const AppRoutes = () => (
  <Routes>
    <Route path="/"          element={<Navigate to="/dashboard" replace />} />
    <Route path="/login"     element={<PublicRoute><AuthForm /></PublicRoute>} />
    <Route path="/dashboard" element={
      <ProtectedRoute>
        <LocationProvider>
          <Dashboard />
        </LocationProvider>
      </ProtectedRoute>
    } />
    <Route path="*" element={<Navigate to="/dashboard" replace />} />
  </Routes>
);

const App = () => (
  <BrowserRouter>
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  </BrowserRouter>
);

export default App;
