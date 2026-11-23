const EventEmitter = require('events');

class MonitorEventBus extends EventEmitter {}

const eventBus = new MonitorEventBus();
eventBus.setMaxListeners(50);

module.exports = eventBus;
