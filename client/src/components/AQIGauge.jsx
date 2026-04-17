import React from 'react';

const getColor = (aqi) => {
  if (aqi <= 50)  return '#22c55e';
  if (aqi <= 100) return '#84cc16';
  if (aqi <= 200) return '#eab308';
  if (aqi <= 300) return '#f97316';
  if (aqi <= 400) return '#ef4444';
  return '#7f1d1d';
};

const getLabel = (aqi) => {
  if (aqi <= 50)  return 'Good';
  if (aqi <= 100) return 'Satisfactory';
  if (aqi <= 200) return 'Moderate';
  if (aqi <= 300) return 'Poor';
  if (aqi <= 400) return 'Very Poor';
  return 'Severe';
};

const AQIGauge = ({ aqi = 0, size = 200 }) => {
  const color      = getColor(aqi);
  const label      = getLabel(aqi);
  const clamped    = Math.min(500, Math.max(0, aqi));
  const cx = size / 2;
  const cy = size / 2 + 10;
  const r  = 80;
  const startAngle = -210;
  const totalArc   = 240;
  const toRad      = (d) => (d * Math.PI) / 180;

  const arcPath = (start, end) => {
    const x1 = cx + r * Math.cos(toRad(start));
    const y1 = cy + r * Math.sin(toRad(start));
    const x2 = cx + r * Math.cos(toRad(end));
    const y2 = cy + r * Math.sin(toRad(end));
    const large = end - start > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const fillAngle  = startAngle + (clamped / 500) * totalArc;
  const needleAngle = fillAngle;
  const nx = cx + (r - 18) * Math.cos(toRad(needleAngle));
  const ny = cy + (r - 18) * Math.sin(toRad(needleAngle));

  return (
    <div style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={arcPath(startAngle, startAngle + totalArc)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="16" strokeLinecap="round" />
        {clamped > 0 && (
          <path d={arcPath(startAngle, fillAngle)} fill="none" stroke={color} strokeWidth="16" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 6px ${color}80)` }} />
        )}
        <circle cx={nx} cy={ny} r="6" fill={color} />
        <circle cx={cx} cy={cy} r="5" fill="rgba(255,255,255,0.2)" />
        <text x={cx} y={cy - 8}  textAnchor="middle" fontSize="38" fontWeight="700" fill={color} fontFamily="system-ui" style={{ filter: `drop-shadow(0 0 8px ${color}60)` }}>{aqi}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize="13" fill="rgba(255,255,255,0.5)" fontFamily="system-ui" fontWeight="500" letterSpacing="1">AQI</text>
        <text x={cx} y={cy + 36} textAnchor="middle" fontSize="14" fill={color} fontFamily="system-ui" fontWeight="600">{label}</text>
      </svg>
    </div>
  );
};

export default AQIGauge;
