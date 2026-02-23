module.exports = {
    apps: [{
        name: 'fishbig',
        script: 'src/index.ts',
        interpreter: 'node',
        interpreter_args: '--loader ts-node/esm',
        cwd: __dirname,
        autorestart: true,
        max_restarts: 10,
        restart_delay: 5000,
        watch: false,
        env: {
            NODE_ENV: 'production',
            FEISHU_CHAT_ID: '',  // Fill with your Feishu group chat ID
        },
        error_file: 'logs/error.log',
        out_file: 'logs/out.log',
        merge_logs: true,
        time: true,
    }],
};
