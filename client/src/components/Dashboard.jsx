import React, { useEffect, useState, useCallback } from 'react';
import { useAuth }     from '../context/AuthContext';
import { useLocation } from '../context/LocationContext';
import { aqiAPI }      from '../api';
import DistrictSelector from './DistrictSelector';
import AQIGauge         from './AQIGauge';
import PollutantCards   from './PollutantCards';
import ForecastChart    from './ForecastChart';
import HistoricalChart  from './HistoricalChart';
import HealthAdvisory   from './HealthAdvisory';

const Dashboard = () => {
  const { user, logout, updateLastDistrict }                               = useAuth();
  const { selectedDistrict, coords, getLocationParams, requestGeolocation, locationError } = useLocation();

  const [dashData,     setDashData]     = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [activeTab,    setActiveTab]    = useState('overview');
  const [initialized,  setInitialized]  = useState(false);

  const fetchDashboard = useCallback(async (params) => {
    if (!params) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await aqiAPI.getDashboard(params);
      setDashData(data.data);
      if (data.data?.district) updateLastDistrict(data.data.district);
    } catch (err) {
      const msg        = err.response?.data?.error || 'Failed to fetch AQI data.';
      const suggestion = err.response?.data?.suggestion || '';
      setError(suggestion ? `${msg} ${suggestion}` : msg);
    } finally {
      setLoading(false);
    }
  }, [updateLastDistrict]);

  // On first load — use last known district or request geolocation
  useEffect(() => {
    if (initialized) return;
    setInitialized(true);
    if (user?.lastKnownDistrict) fetchDashboard({ district: user.lastKnownDistrict });
    else requestGeolocation();
  }, [initialized, user, fetchDashboard, requestGeolocation]);

  // Re-fetch when location changes
  useEffect(() => {
    if (!initialized) return;
    const p = getLocationParams();
    if (p) fetchDashboard(p);
  }, [selectedDistrict, coords]);

  // If geolocation fails and no data, fall back to Delhi
  useEffect(() => {
    if (locationError && !dashData && !loading) fetchDashboard({ district: 'Delhi' });
  }, [locationError, dashData, loading]);

  const current     = dashData?.current;
  const displayName = current?.district || selectedDistrict || 'Detecting location...';
  const modelStatus = dashData?.meta?.modelStatus;

  return (
    <div className="dashboard">
      {/* Navbar */}
      <nav className="navbar">
        <div className="navbar-brand">
          <span className="brand-leaf">🌿</span>
          <span className="brand-text">Aerosense</span>
        </div>
        <div className="navbar-center">
          <DistrictSelector onSelect={(d) => fetchDashboard({ district: d })} />
        </div>
        <div className="navbar-right">
          <div className="user-info">
            <span className="user-avatar">{user?.name?.[0]?.toUpperCase()}</span>
            <span className="user-name">{user?.name}</span>
          </div>
          <button className="logout-btn" onClick={logout}>Sign Out</button>
        </div>
      </nav>

      <main className="dashboard-main">
        {/* Location header */}
        <div className="location-header">
          <div>
            <h1 className="location-title">
              <span className="location-pin">📍</span> {displayName}
            </h1>
            <div className="location-meta-row">
              {current?.state       && <span className="location-sub">{current.state}</span>}
              {current?.stationName && <span className="station-tag">📡 {current.stationName}</span>}
              {current?.dataAge     && <span className="data-age">Updated {current.dataAge}</span>}
            </div>
          </div>
          <div className="header-right">
            <div className="data-source-badge">
              <span className="live-dot" />
              <span>Live · CPCB India</span>
            </div>
            <button className="refresh-btn" onClick={() => { const p = getLocationParams(); if (p) fetchDashboard({ ...p, force: true }); }} disabled={loading}>
              {loading ? '⏳' : '🔄'} Refresh
            </button>
          </div>
        </div>

        {/* ML model notice */}
        {modelStatus === 'statistical_baseline' && dashData && (
          <div className="info-banner">
            <span>🤖</span>
            <span><strong>Actual AQI is live from CPCB.</strong> Forecast uses a statistical model. Set <code>ML_SERVICE_URL</code> in .env to connect your ML model.</span>
          </div>
        )}

        {error && <div className="error-banner"><span>⚠️</span> {error}</div>}

        {loading && !dashData && (
          <div className="loading-screen">
            <div className="loading-orb" />
            <p>Fetching live CPCB data...</p>
          </div>
        )}

        {dashData && (
          <>
            <div className="tab-nav">
              {['overview', 'forecast', 'history'].map((tab) => (
                <button key={tab} className={`tab-pill ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)}>
                  {tab === 'overview' && '📊 Overview'}
                  {tab === 'forecast' && '🔮 48h Forecast'}
                  {tab === 'history'  && '📈 10-Day History'}
                </button>
              ))}
            </div>

            {activeTab === 'overview' && (
              <div className="tab-content">
                <div className="overview-top">
                  <div className="gauge-section">
                    <AQIGauge aqi={current?.actualAQI} size={220} />
                    <div className="aqi-meta">
                      <div className="meta-row"><span className="meta-label">Category</span>   <span className="meta-value" style={{ color: current?.category?.color }}>{current?.category?.label}</span></div>
                      <div className="meta-row"><span className="meta-label">Risk Level</span>  <span className="meta-value">{current?.category?.risk?.replace('_', ' ')}</span></div>
                      <div className="meta-row"><span className="meta-label">Data Source</span> <span className="meta-value cpcb-label">CPCB ✓</span></div>
                      {current?.recordedAt && (
                        <div className="meta-row">
                          <span className="meta-label">Recorded</span>
                          <span className="meta-value">{new Date(current.recordedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <HealthAdvisory advisory={current?.advisory} category={current?.category} />
                </div>
                <div className="section-title">Pollutant Concentrations — Live CPCB Data</div>
                <PollutantCards pollutants={current?.pollutants} />
              </div>
            )}

            {activeTab === 'forecast' && (
              <div className="tab-content">
                <ForecastChart forecast={dashData.forecast} modelType={modelStatus} />
              </div>
            )}

            {activeTab === 'history' && (
              <div className="tab-content">
                <HistoricalChart history={dashData.history?.history} avgAccuracy={dashData.history?.avgAccuracy} source={dashData.history?.source} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default Dashboard;
