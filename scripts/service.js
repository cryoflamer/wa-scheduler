const { installService, removeService, serviceStatus } = require('../src/service');

const command = process.argv[2];

try {
    if (command === 'install') {
        console.log(`Service installed: ${installService()}`);
    } else if (command === 'status') {
        console.log(serviceStatus());
    } else if (command === 'remove') {
        console.log(`Service removed: ${removeService()}`);
    } else {
        throw new Error('Usage: node scripts/service.js <install|status|remove>');
    }
} catch (error) {
    console.error(`Service command failed: ${error.message}`);
    process.exitCode = 1;
}
