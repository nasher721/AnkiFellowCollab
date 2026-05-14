import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

function reportWebVitals(metric) {
  if (process.env.NODE_ENV === 'production') {
    const body = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      url: location.pathname
    });
    navigator.sendBeacon?.('/api/analytics/web-vitals', body);
  }
  if (process.env.NODE_ENV === 'development') {
    console.log(`[web-vitals] ${metric.name}: ${metric.value.toFixed(2)} (${metric.rating})`);
  }
}

onCLS(reportWebVitals);
onFCP(reportWebVitals);
onINP(reportWebVitals);
onLCP(reportWebVitals);
onTTFB(reportWebVitals);
