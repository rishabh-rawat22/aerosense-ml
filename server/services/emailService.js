// server/services/emailService.js

var nodemailer = require("nodemailer");

// Transporter - reads credentials from environment variables
var transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify transporter configuration once on startup
transporter.verify(function(err) {
  if (err) {
    console.error("[EmailService] SMTP configuration error:", err.message);
  } else {
    console.log("[EmailService] SMTP transporter ready.");
  }
});

// Maps AQI to severity label and color
function getAqiMeta(aqi) {
  if (aqi <= 50)  return { label: "Good",         color: "#22c55e" };
  if (aqi <= 100) return { label: "Satisfactory",  color: "#84cc16" };
  if (aqi <= 200) return { label: "Moderate",      color: "#eab308" };
  if (aqi <= 300) return { label: "Poor",          color: "#f97316" };
  if (aqi <= 400) return { label: "Very Poor",     color: "#ef4444" };
  return                  { label: "Severe",        color: "#7f1d1d" };
}

// Builds the HTML body for an AQI alert email
function buildAqiAlertHtml(opts) {
  var name = opts.name;
  var district = opts.district;
  var aqi = opts.aqi;
  var meta = getAqiMeta(aqi);
  var label = meta.label;
  var color = meta.color;
  var firstName = name ? name.split(" ")[0] : "there";
  var timestamp = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "long",
    timeStyle: "short",
  });
  var dashboardUrl = (process.env.CLIENT_URL || "https://aerosense-eosin.vercel.app") + "/dashboard";
  var settingsUrl = (process.env.CLIENT_URL || "https://aerosense-eosin.vercel.app") + "/settings";

  return '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'  <meta charset="UTF-8" />' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
'  <title>AQI Alert - AeroSense</title>' +
'</head>' +
'<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Arial,sans-serif;">' +
'  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">' +
'    <tr><td align="center">' +
'      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">' +
'        <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:32px 40px;text-align:center;">' +
'          <p style="margin:0;font-size:28px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;">AeroSense</p>' +
'          <p style="margin:8px 0 0;font-size:13px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;">Air Quality Intelligence</p>' +
'        </td></tr>' +
'        <tr><td style="padding:0;text-align:center;background:#f8fafc;">' +
'          <div style="display:inline-block;margin:28px auto;background:' + color + ';border-radius:12px;padding:14px 36px;">' +
'            <p style="margin:0;font-size:13px;font-weight:600;color:#fff;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">Current AQI - ' + district + '</p>' +
'            <p style="margin:4px 0 0;font-size:56px;font-weight:900;color:#fff;line-height:1;">' + aqi + '</p>' +
'            <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#fff;opacity:0.9;">' + label + '</p>' +
'          </div>' +
'        </td></tr>' +
'        <tr><td style="padding:0 40px 32px;">' +
'          <p style="margin:0 0 16px;font-size:16px;color:#1e293b;">Hi <strong>' + firstName + '</strong>,</p>' +
'          <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.7;">Our sensors have detected that the Air Quality Index in <strong>' + district + '</strong> has reached <strong>' + aqi + '</strong>, which is classified as <strong style="color:' + color + ';">' + label + '</strong>. This level of air pollution can be harmful, especially for children, the elderly, and those with respiratory conditions.</p>' +
'          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border-left:4px solid ' + color + ';border-radius:0 8px 8px 0;margin:24px 0;">' +
'            <tr><td style="padding:16px 20px;">' +
'              <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#9a3412;letter-spacing:0.5px;text-transform:uppercase;">Health Advisory</p>' +
'              <ul style="margin:0;padding-left:20px;font-size:14px;color:#431407;line-height:1.9;">' +
'                <li>Wear an <strong>N95 or equivalent mask</strong> when going outdoors.</li>' +
'                <li>Avoid prolonged outdoor activities and exercise outside.</li>' +
'                <li>Keep windows and doors closed; use an air purifier if available.</li>' +
'                <li>Stay hydrated and monitor symptoms like coughing or eye irritation.</li>' +
'                <li>Vulnerable individuals should stay indoors as much as possible.</li>' +
'              </ul>' +
'            </td></tr>' +
'          </table>' +
'          <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">You are receiving this alert because real-time monitoring in your area (<strong>' + district + '</strong>) has crossed the Poor air quality threshold. We will notify you again if conditions worsen or improve significantly.</p>' +
'          <table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
'            <td style="border-radius:8px;background:#1e3a5f;"><a href="' + dashboardUrl + '" target="_blank" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.3px;">View Live AQI Dashboard</a></td>' +
'          </tr></table>' +
'        </td></tr>' +
'        <tr><td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">' +
'          <p style="margin:0 0 6px;font-size:12px;color:#94a3b8;">Measured on ' + timestamp + ' (IST) - Data source: Government CPCB Sensors</p>' +
'          <p style="margin:0;font-size:12px;color:#94a3b8;">You can disable these alerts in your <a href="' + settingsUrl + '" style="color:#3b82f6;text-decoration:none;">AeroSense account settings</a>.</p>' +
'        </td></tr>' +
'      </table>' +
'    </td></tr>' +
'  </table>' +
'</body></html>';
}

// Sends an AQI alert email to a single recipient
async function sendAqiAlert(opts) {
  var meta = getAqiMeta(opts.aqi);

  var mailOptions = {
    from: process.env.EMAIL_FROM || ("AeroSense Alerts <" + process.env.EMAIL_USER + ">"),
    to: opts.to,
    subject: "Poor Air Quality Alert for " + opts.district + " - AQI " + opts.aqi + " (" + meta.label + ")",
    html: buildAqiAlertHtml({ name: opts.name, district: opts.district, aqi: opts.aqi }),
    text: "Hi " + opts.name + ",\n\n" +
          "AeroSense Alert: The current AQI in " + opts.district + " is " + opts.aqi + " (" + meta.label + ").\n\n" +
          "Health Advisory:\n" +
          "- Wear an N95 or equivalent mask outdoors.\n" +
          "- Avoid prolonged outdoor activities.\n" +
          "- Keep windows closed; use an air purifier if available.\n" +
          "- Vulnerable individuals should stay indoors.\n\n" +
          "Stay safe,\nThe AeroSense Team",
  };

  return transporter.sendMail(mailOptions);
}

module.exports = { sendAqiAlert: sendAqiAlert };
