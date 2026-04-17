import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const AuthForm = () => {
  const [mode,     setMode]     = useState('login');
  const [form,     setForm]     = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors,   setErrors]   = useState({});
  const [apiError, setApiError] = useState('');
  const [loading,  setLoading]  = useState(false);
  const { login, register }     = useAuth();
  const navigate                = useNavigate();

  const validate = () => {
    const e = {};
    if (mode === 'register') {
      if (!form.name.trim() || form.name.length < 2) e.name = 'Name must be at least 2 characters';
      if (form.password !== form.confirm) e.confirm = 'Passwords do not match';
    }
    if (!form.email || !/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Valid email required';
    if (!form.password || form.password.length < 6) e.password = 'Password must be at least 6 characters';
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError('');
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
    setLoading(true);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
      navigate('/dashboard');
    } catch (err) {
      setApiError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    setForm((p) => ({ ...p, [e.target.name]: e.target.value }));
    setErrors((p) => ({ ...p, [e.target.name]: '' }));
  };

  const switchMode = (m) => { setMode(m); setErrors({}); setApiError(''); };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <div className="auth-brand">
          <div className="brand-icon">🌿</div>
          <h1 className="brand-name">Aerosense</h1>
          <p className="brand-tagline">Intelligent Air Quality Intelligence for India</p>
          <p className="brand-source">Live data from CPCB · Central Pollution Control Board</p>
        </div>

        <div className="auth-tabs">
          <button className={`tab-btn ${mode === 'login'    ? 'active' : ''}`} onClick={() => switchMode('login')}>Sign In</button>
          <button className={`tab-btn ${mode === 'register' ? 'active' : ''}`} onClick={() => switchMode('register')}>Create Account</button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          {apiError && <div className="alert alert-error"><span>⚠</span> {apiError}</div>}

          {mode === 'register' && (
            <div className="field-group">
              <label htmlFor="name" className="field-label">Full Name</label>
              <input id="name" name="name" type="text" value={form.name} onChange={handleChange} placeholder="Priya Sharma" className={`field-input ${errors.name ? 'error' : ''}`} />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </div>
          )}

          <div className="field-group">
            <label htmlFor="email" className="field-label">Email Address</label>
            <input id="email" name="email" type="email" value={form.email} onChange={handleChange} placeholder="you@example.com" className={`field-input ${errors.email ? 'error' : ''}`} autoComplete="email" />
            {errors.email && <span className="field-error">{errors.email}</span>}
          </div>

          <div className="field-group">
            <label htmlFor="password" className="field-label">Password</label>
            <input id="password" name="password" type="password" value={form.password} onChange={handleChange} placeholder="Min. 6 characters" className={`field-input ${errors.password ? 'error' : ''}`} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {errors.password && <span className="field-error">{errors.password}</span>}
          </div>

          {mode === 'register' && (
            <div className="field-group">
              <label htmlFor="confirm" className="field-label">Confirm Password</label>
              <input id="confirm" name="confirm" type="password" value={form.confirm} onChange={handleChange} placeholder="Repeat your password" className={`field-input ${errors.confirm ? 'error' : ''}`} autoComplete="new-password" />
              {errors.confirm && <span className="field-error">{errors.confirm}</span>}
            </div>
          )}

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading
              ? <span className="loading-dots"><span /><span /><span /></span>
              : mode === 'login' ? 'Sign In →' : 'Create Account →'}
          </button>
        </form>

        <p className="auth-footer">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button className="link-btn" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Sign up free' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
};

export default AuthForm;
