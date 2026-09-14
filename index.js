import './app/tasks/registerRadarLocationTask';
import 'expo-router/entry';
// #region agent log
fetch('http://127.0.0.1:7630/ingest/de13606f-ba56-41c9-af73-87b91ac29696',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ab38e3'},body:JSON.stringify({sessionId:'ab38e3',runId:'post-fix',hypothesisId:'E',location:'index.js',message:'entry loaded light task registrar; TrackPlayer removed',data:{},timestamp:Date.now()})}).catch(()=>{});
// #endregion
