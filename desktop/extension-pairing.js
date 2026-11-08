importScripts('background.js');

// This file is used only by the desktop copy of the extension. The short-lived
// challenge is generated locally and never includes the actual pairing token.
// The desktop installer retargets this loopback address with the worker copy.
let desktopPairingFlight;
async function pairWithDesktop(){
  if(desktopPairingFlight)return;
  desktopPairingFlight=(async()=>{
    const file=await fetch(chrome.runtime.getURL('desktop-pairing.json'),{cache:'no-store'});
    if(!file.ok)return;
    const {code,expiresAt}=await file.json();
    if(!/^[a-f0-9]{64}$/.test(code)||expiresAt<=Date.now())return;
    const {desktopPairingSeen}=await chrome.storage.local.get('desktopPairingSeen');
    if(desktopPairingSeen===code)return;
    const response=await fetch('http://127.0.0.1:17321/api/desktop-pair',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)return;
    const {extensionToken}=await response.json();
    if(!/^[a-f0-9]{64}$/.test(extensionToken))return;
    await chrome.storage.local.set({token:extensionToken,desktopPairingSeen:code});
  })();
  try{await desktopPairingFlight;}catch{}finally{desktopPairingFlight=undefined;}
}
chrome.alarms.create('desktopPairing',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='desktopPairing')void pairWithDesktop();});
void pairWithDesktop();
