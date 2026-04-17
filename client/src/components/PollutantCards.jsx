import React from 'react';

const POLLUTANTS = [
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³', safe: 60,  icon: '🌫️', desc: 'Fine particles' },
  { key: 'pm10', label: 'PM10',  unit: 'μg/m³', safe: 100, icon: '💨', desc: 'Coarse particles' },
  { key: 'no2',  label: 'NO₂',  unit: 'μg/m³', safe: 80,  icon: '🏭', desc: 'Nitrogen Dioxide' },
  { key: 'so2',  label: 'SO₂',  unit: 'μg/m³', safe: 80,  icon: '⚗️', desc: 'Sulfur Dioxide' },
  { key: 'co',   label: 'CO',   unit: 'mg/m³', safe: 2,   icon: '🚗', desc: 'Carbon Monoxide' },
  { key: 'o3',   label: 'O₃',   unit: 'μg/m³', safe: 100, icon: '🌐', desc: 'Ozone' },
];

const PollutantCards = ({ pollutants = {} }) => (
  <div className="pollutant-grid">
    {POLLUTANTS.map(({ key, label, unit, safe, icon, desc }) => {
      const value  = pollutants[key];
      const hasVal = value != null;
      const pct    = hasVal ? Math.min(100, (value / (safe * 1.5)) * 100) : 0;
      const isHigh = hasVal && value > safe;

      return (
        <div className={`pollutant-card ${isHigh ? 'high' : 'normal'}`} key={key}>
          <div className="pollutant-header">
            <span className="pollutant-icon">{icon}</span>
            <div>
              <div className="pollutant-name">{label}</div>
              <div className="pollutant-desc">{desc}</div>
            </div>
          </div>
          <div className="pollutant-value-row">
            {hasVal
              ? <><span className={`pollutant-value ${isHigh ? 'danger' : ''}`}>{value}</span><span className="pollutant-unit">{unit}</span></>
              : <span className="pollutant-na">N/A</span>}
          </div>
          <div className="pollutant-bar-bg">
            <div className="pollutant-bar-fill" style={{ width: `${pct}%`, background: isHigh ? 'linear-gradient(90deg,#f97316,#ef4444)' : 'linear-gradient(90deg,#22c55e,#84cc16)' }} />
          </div>
          <div className="pollutant-safe-label">Safe limit: {safe} {unit}</div>
        </div>
      );
    })}
  </div>
);

export default PollutantCards;
