import React from 'react';

const CLASS_MAP = {
  'Good': 'advisory-good', 'Satisfactory': 'advisory-satisfactory',
  'Moderate': 'advisory-moderate', 'Poor': 'advisory-poor',
  'Very Poor': 'advisory-verypoor', 'Severe': 'advisory-severe',
};

const HealthAdvisory = ({ advisory, category }) => {
  if (!advisory) return null;
  return (
    <div className={`health-advisory ${CLASS_MAP[category?.label] || 'advisory-moderate'}`}>
      <div className="advisory-header">
        <span className="advisory-icon">{advisory.icon}</span>
        <div>
          <h3 className="advisory-title">Health Advisory</h3>
          <span className="advisory-level">{category?.label}</span>
        </div>
      </div>
      <div className="advisory-items">
        <div className="advisory-item"><span className="advisory-dot" /><div><strong>General:</strong> {advisory.general}</div></div>
        <div className="advisory-item"><span className="advisory-dot advisory-dot-warn" /><div><strong>Sensitive Groups:</strong> {advisory.sensitive}</div></div>
        <div className="advisory-item"><span className="advisory-dot advisory-dot-info" /><div><strong>Outdoor Activity:</strong> {advisory.outdoor}</div></div>
      </div>
      <div className="advisory-footer">🏥 Consult a medical professional if you experience symptoms</div>
    </div>
  );
};

export default HealthAdvisory;
