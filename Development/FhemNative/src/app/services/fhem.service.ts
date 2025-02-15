import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { SettingsService } from './settings.service';
import { StructureService } from './structure.service';
import { ToastService } from './toast.service';

// Translator
import { TranslateService } from '@ngx-translate/core';

@Injectable({
	providedIn: 'root'
})

export class FhemService {

	// device subscription and total device list;
	public devicesSub = new Subject<any>();
	public deviceGetSub = new Subject<any>();
	public devicesListSub = new Subject<any>();
	public devices: Array<any> = [];

	// connection state
	public connected = false;

	// devices loaded callback
	public loadedDevices = new Subject<boolean>();
	public devicesLoaded = false;

	private socket: any;

	private tries: number = 0;
	private maxTries: number = 10;

	// no Reconnect
	public noReconnect = false;
	private timeout:any;

	// list of device to listen for changes
	private listenDevices: Array<any> = [];

	// combining changes to reduce messages
    private combinedDevices: Array<any> = [];

    constructor(
		private settings: SettingsService,
		private structure: StructureService,
		private toast: ToastService,
		private translate: TranslateService) {

    	// subscribe to load Event (all devices loaded)
      	this.loadedDevices.subscribe(next => {
      		const pre = this.devicesLoaded;
      		this.devicesLoaded = next;
      		if (next && pre !== this.devicesLoaded) {
      			this.toast.addToast(
      				this.translate.instant('GENERAL.FHEM.TITLE'),
      				this.translate.instant('GENERAL.FHEM.FETCHED_ALL_DEVICES'),
      				'success'
      			);
      		}
      	});
      	// subscribe to eventchanges
      	this.devicesSub.subscribe(next => {
      		const index = this.findIndex(this.devices, 'device', next.found.device);
      		if (index !== null) {
      			for (const key in next.found.readings) {
      				if (next.found.readings.hasOwnProperty(key)) {
      					// STATE exception
      					if (next.change.changed.STATE) {
      						const val = next.change.changed.STATE;
      						this.devices[index].readings.state.Value = val;
      						this.devices[index].readings.state.Time = new Date;
      					}
      					if (next.change.changed[key] !== undefined) {
      						const val = next.change.changed[key];
      						this.devices[index].readings[key].Value = val;
      						this.devices[index].readings[key].Time = new Date;
      					}
      				}
      			}
      			let timerRuns = false;
      			if (!this.combinedDevices.includes(next.found.device)) {
      				this.combinedDevices.push(next.found.device);
      				if (!timerRuns) {
	      				timerRuns = true;
	      				setTimeout(() => {
	      					if (this.combinedDevices.length > 0) {
	      						this.toast.addToast(
	      							this.translate.instant('GENERAL.FHEM.TITLE'),
	      							this.translate.instant('GENERAL.FHEM.DEVICE_UPDATE') + this.combinedDevices.join(', '),
	      							'info'
	      						);
	      						this.combinedDevices = [];
	      					}
	      					timerRuns = false;
	      				}, 300);
	      			}
      			}
      		}
      	});
    }

    private connectionEvaluator() {
    	// set connection default to websocket
    	let result = 'websocket';
    	if (this.settings.IPsettings.type) {
    		if (this.settings.IPsettings.type === 'Fhemweb') {
				result = 'fhemweb';
			}
			   if (this.settings.IPsettings.type === 'MQTT') {
				result = 'mqtt';
			}
    	}
    	return result;
    }

    public connectFhem() {
    	return new Promise((resolve, reject) => {
    		this.establishConnection().then((e) => {
    			const type = this.connectionEvaluator();
    			// get all devices for desired connection type
    			this.listDevices(this.settings.app.loadFhemDevices.enable ? '.*' : this.getRelevantDevices());
    			// initialize events
    			if (type === 'websocket' || type === 'fhemweb') {
	    			this.websocketEvents();
	    		}
    			resolve(e);
			}).catch((e) => {
				reject(e);
			});
    	});
    }

    public listDevices(attr){
    	const type = this.connectionEvaluator();
    	if (type === 'websocket') {
    		this.socket.send(JSON.stringify(
	    		{type: 'command', payload: {command: 'list', arg: attr}}
	    	));
    	}
    	if (type === 'fhemweb') {
	    	this.socket.send('jsonlist2 '+ attr);
	    }
    }

    private getRelevantDevices(){
    	let list: any= [];

    	let test = (obj)=>{
    		if(obj && obj.value !== '' && !list.includes(obj.value)){
    			list.push(obj.value);
    		}
    	}

    	this.structure.rooms.forEach((room)=>{
    		this.structure.modifyComponentList(room.components,  (cb)=>{
    			if(cb.attributes.attr_data){
    				test(cb.attributes.attr_data.find(x=> x.attr === 'data_device'));
    			}
    		});
    	});

    	list = '('+list.join('|')+')';
    	// add fhem defined relevant components , if needed
    	if(this.settings.app.loadFhemDevices.option === 'Fhem_Defined'){
    		list = 'group=FhemNative,'+list
    	}
    	
    	return list;
    }

    private establishConnection() {
    	// establish the connection based on settings
    	return new Promise((resolve, reject) => {
			if (!this.connected) {
				let url;
				// get the desired url for fhem connection
				const type = this.connectionEvaluator();
				if (type === 'websocket') {
					// external websocket connection
					url = (this.settings.IPsettings.WSS ? 'wss://' : 'ws://') + 
					(this.settings.IPsettings.basicAuth ? this.settings.IPsettings.USER + ':' + this.settings.IPsettings.PASSW + '@' : '' ) + 
					this.settings.IPsettings.IP + ':' + this.settings.IPsettings.PORT;

					this.socket = new WebSocket(url, ['json']);
				}
				if (type === 'fhemweb') {
					// fhemweb connection
					url = (this.settings.IPsettings.WSS ? 'wss://' : 'ws://') + 
					(this.settings.IPsettings.basicAuth ? this.settings.IPsettings.USER + ':' + this.settings.IPsettings.PASSW + '@' : '' ) + 
					this.settings.IPsettings.IP + ':' + this.settings.IPsettings.PORT +
					'?XHR=1&inform=type=status;filter=.*;fmt=JSON' + '&timestamp=' + Date.now();

					this.socket = new WebSocket(url);
				}
				// clearing device lists
				this.devices = [];
				this.listenDevices = [];
				if (type === 'websocket' || type === 'fhemweb') {
					// websocket connection
					this.socket.onopen = (e) => {
						this.connected = true;
						this.toast.addToast(
							this.translate.instant('GENERAL.FHEM.TITLE'),
							this.translate.instant('GENERAL.FHEM.CONNECTED'),
							'success'
						);
						resolve(e);
					};
					this.socket.onclose = () => {
						this.connected = false;
						this.loadedDevices.next(false);
						this.reconnect();
						this.toast.addToast(
							this.translate.instant('GENERAL.FHEM.TITLE'),
							this.translate.instant('GENERAL.FHEM.DISCONNECT'),
							'error'
						);
					};
					this.socket.onerror = (e) => {
						this.reconnect();
						this.toast.addToast(
							this.translate.instant('GENERAL.FHEM.TITLE'),
							this.translate.instant('GENERAL.FHEM.ERROR'),
							'error'
						);
						reject(e);
					};
				}
				// timeout for connection
				if(this.timeout){
					clearTimeout(this.timeout);
				}
				this.timeout = setTimeout(() => {
					// check if connection ever was established
					if (!this.connected) {
						this.noReconnect = true;
						this.toast.addToast(
							this.translate.instant('GENERAL.FHEM.TITLE'),
							this.translate.instant('GENERAL.FHEM.TIMEOUT'),
							'error'
						);
						reject({type: 'timeout'});
						this.tries = 0;
					}
				}, 3000);
			}
		});
    }

    private reconnect(){
    	if (!this.noReconnect) {
    		this.tries ++;
    		if(this.tries <= this.maxTries){
    			const timeout = setTimeout(() => {
					this.connectFhem();
				}, 1000);
    		}
    	}
    }

    private websocketEvents() {
    	const type = this.connectionEvaluator();
    	this.socket.onmessage = (e) => {
    		let msg = e.data;
    		// desired websocket message handling
    		if (type === 'websocket') {
    			msg = JSON.parse(msg);
    			if (msg.type === 'listentry') {
    				// search for reply device in device list
    				const device = this.find(this.devices, 'device', msg.payload.name);
    				if (!device && msg.payload.attributes) {
    					this.devices.push({
    						id: msg.payload.internals.NR,
    						device: msg.payload.name,
			    			readings: msg.payload.readings,
			    			internals: msg.payload.internals,
			    			attributes: msg.payload.attributes
    					});
    				}
    				// all devices loaded
    				if ((this.devices.length === msg.payload.num) || (!this.settings.app.loadFhemDevices.enable && this.devices.length === 0) || (this.settings.app.loadFhemDevices.option === 'Fhem_defined' && this.devices.length === msg.payload.num -1)) {
    					this.loadedDevices.next(true);
    					this.returnListDevices(this.settings.app.loadFhemDevices.option === 'Fhem_defined' ? msg.payload.num - 1 : msg.payload.num);
    				}
    			}
    			if (msg.type === 'event') {
    				const found = this.find(this.listenDevices, 'device', msg.payload.name);
    				if (found) {
    					const res = msg.payload;
						   res.changed = this.objResolver(res.changed, 2);
						   this.devicesSub.next({found, change: res});
    				}
    			}
    			if (msg.type === 'getreply') {
					const found = this.find(this.listenDevices, 'device', msg.payload.device);
					if (found) {
						this.deviceGetSub.next(msg);
					}
				}
    		}
    		// Fhemweb reply
    		if (type === 'fhemweb') {
    			let lines = msg.split(/\n/);
      			lines = lines.filter(s => s != '' && s != '[""]');
      			if (lines.length > 0) {
      				// evaluation for: get all devices
      				if (lines.length === 1) {
						msg = JSON.parse(msg);
						if (this.IsJsonString(msg)) {
							// normal reply
							msg = JSON.parse(msg);
							if(msg.Results.length === 0){
								// initially loaded 0 devices
								if(this.devices.length === 0){
									this.loadedDevices.next(true);
								}
							}else{
								// keep track of new devices
								let newDevices = 0;
								// detect if initial load
								msg.Results.forEach((result, i)=>{
									const index = this.findIndex(this.devices, 'device', msg.Results[i].Name);
									if(index !== null){
										// device already found
										this.devices[index].readings = this.objResolver(msg.Results[i].Readings, 1);
									}else{
										// new device
										newDevices++;
										this.devices.push({
			      							id: parseInt(msg.Results[i].Internals.NR),
			      							device: msg.Results[i].Name,
			      							readings: this.objResolver(msg.Results[i].Readings, 1),
			      							internals: msg.Results[i].Internals,
			      							attributes: msg.Results[i].Attributes
			      						});
									}
									if (i === msg.Results.length - 1) {
										this.loadedDevices.next(true);
										this.returnListDevices(newDevices);
									}
								});
							}
						} else {
							// get reply
							const result = {payload: {
								device: '',
								property: '',
								value: ''
							}};
						}
      				} else {
      					// evaluation of changes
      					const change = {changed: {}};
      					const device = JSON.parse(lines[0])[0];
      					const found = this.find(this.listenDevices, 'device', device);
      					if (found) {
      						// skipping 0 --> 0 is device
	      					for (let i = 1; i < lines.length; i += 2) {
	      						const prop = JSON.parse(lines[i])[0].match(/([^-]+(?=))$/)[0];
	      						const value = JSON.parse(lines[i])[1];
	      						change.changed[prop] = value;
	      					}
      						this.devicesSub.next({found, change: this.objResolver(change, 2)});
      					}
      				}
      			}
    		}
    	};
    }

    private returnListDevices(n){
    	if(n > 0){
    		// remporary copy of devices
	    	const list = JSON.parse(JSON.stringify(this.devices));
	    	this.devicesListSub.next(list.splice(Math.max(list.length - n, 0)));
    	}else{
    		// return empty list if no new devices fetched
    		this.devicesListSub.next([]);
    	}
    }

    public IsJsonString(str) {
    	try {
	        JSON.parse(str);
	    } catch (e) {
	        return false;
	    }
	    return true;
    }

    public getDevice(device, reading) {
    	return new Promise((resolve, reject) => {
    		if (!this.devicesLoaded) {
    			const sub = this.loadedDevices.subscribe((state) => {
					if (state) {
						sub.unsubscribe();
						// check if reading is present before building listener
						resolve(this.deviceReadingFinder(device, reading) ? this.listen(device) : null);
					}
				});
    		} else {
				resolve(this.deviceReadingFinder(device, reading) ? this.listen(device) : null);
			}
    	});
    }

    public deviceReadingFinder(device, reading) {
    	const dev = this.find(this.devices, 'device', device);
    	return (
    		// check for device
    		dev ? (
    			// check if reading is used
    			!reading && reading !== '' ? true : (
    				// reading is used and has to be checked
    				dev.readings[reading] ? true : false
    			)
    		) : false
    	);
    }

    public listen(name) {
    	const found = this.find(this.devices, 'device', name);
    	if (found) {
    		const type = this.connectionEvaluator();
    		found.readings = this.objResolver(found.readings, 1);
    		if (!this.find(this.listenDevices, 'device', name)) {
    			this.listenDevices.push(found);
    			// subsribe based on type
    			if (type === 'websocket') {
    				this.sendCommand({
			    		command: 'subscribe',
			    		arg: found.id,
			    		type: '.*',
			    		name,
			    		changed: ''
			    	});
			    	// getting device info
			    	this.sendCommand({
			    		command: 'list',
			    		arg: name
			    	});
    			}
    			if (type === 'fhemweb') {
    				this.socket.send('jsonlist2 ' + name);
    			}
    		}
    	}
    	return found;
    }

    public sendCommand(cmd) {
    	const type = this.connectionEvaluator();
    	if (type === 'websocket') {
    		this.socket.send(JSON.stringify({
	            type: 'command',
	            payload: cmd
	        }));
    	}
    	if (type === 'fhemweb') {
    		this.socket.send(cmd.command);
    	}
    }

    public disconnect() {
    	if(this.connected){
    		this.socket.close();
    	}
	}

	public setReading(device, reading, value) {
        this.sendCommand({
            command: 'setReading ' + device + ' ' + reading + ' ' + value
        });
    }

    public setAttr(device, prop, value) {
        this.sendCommand({
            command: 'set ' + device + ' ' + prop + ' ' + value
        });
    }

    public set(device, value) {
        this.sendCommand({
            command: 'set ' + device + ' ' + value
        });
    }

    public get(device, property) {
    	const type = this.connectionEvaluator();
    	if (type === 'websocket') {
    		this.sendCommand({
	            command: 'get',
	            device,
	            property
	        });
    	}
    	if (type === 'fhemweb') {
    		this.sendCommand({
    			command: 'get ' + device + ' ' + property
    		});
    	}
    }

    public find(array, key, value) {
		for (let i = 0; i < array.length; i++) {
	    	if (array[i][key] === value) {
	    		return array[i];
	      	}
	    }
	 return null;
	}

	public findIndex(array, key, value) {
		for (let i = 0; i < array.length; i++) {
	    	if (array[i][key] === value) {
	    		return i;
	      	}
	    }
	 return null;
	}

	public objResolver(obj, level) {
		const keys = Object.keys(obj);
		const result = {};
		for (let i = 0; i < keys.length; i++) {
			const val = (level === 1 ? obj[keys[i]].Value : obj[keys[i]]);
			if (level === 1) {
				result[keys[i]] = {Value: '', Time: ''};
				result[keys[i]].Time = obj[keys[i]].Time;
				result[keys[i]].Value = (val === 'true' || val === 'false') ? JSON.parse(val) : (typeof val === 'boolean') ? val : !isNaN(val) ? parseFloat(val) : val;
			} else {
				result[keys[i]] = (val === 'true' || val === 'false') ? JSON.parse(val) : (typeof val === 'boolean') ? val : !isNaN(val) ? parseFloat(val) : val;
			}
		}
		return result;
	}

	public replyHandler(base, change) {
		const changeKeys = Object.keys(change);
		const result = base;
		for (let i = 0; i < changeKeys.length; i++) {
			result[changeKeys[i]].Value = change[changeKeys[i]];
		}
		return result;
	}
}
