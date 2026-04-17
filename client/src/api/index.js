import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('aerosense_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// Global 401 handler — clear token and redirect to login
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('aerosense_token');
      localStorage.removeItem('aerosense_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  register:       (data)     => api.post('/auth/register', data),
  login:          (data)     => api.post('/auth/login', data),
  getMe:          ()         => api.get('/auth/me'),
  updateDistrict: (district) => api.patch('/auth/update-district', { district }),
  saveLocation:   (data)     => api.post('/auth/save-location', data),
};

export const aqiAPI = {
  getCurrent:   (params) => api.get('/aqi/current',   { params }),
  getForecast:  (params) => api.get('/aqi/forecast',  { params }),
  getHistory:   (params) => api.get('/aqi/history',   { params }),
  getDashboard: (params) => api.get('/aqi/dashboard', { params }),
  getDistricts: (q = '') => api.get('/aqi/districts', { params: { q } }),
  getStations:  ()       => api.get('/aqi/stations'),
  triggerSync:  ()       => api.post('/aqi/sync'),
};

export default api;
