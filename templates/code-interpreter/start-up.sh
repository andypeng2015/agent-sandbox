#!/bin/bash

function start_jupyter_server() {
	counter=0
	response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8888/api/status")
	while [[ ${response} -ne 200 ]]; do
		let counter++
		if ((counter % 20 == 0)); then
			echo "Waiting for Jupyter Server to start..."
			sleep 0.1
		fi

		response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8888/api/status")
	done

	cd /root/.server/
	.venv/bin/uvicorn main:app --host 0.0.0.0 --port 49999 --workers 1 --no-access-log --no-use-colors --timeout-keep-alive 640
}

echo "Starting Code Interpreter Server..."
start_jupyter_server > /proc/1/fd/1 2>&1 &

echo "Starting Envd..."
/workspace/envd/envd > /proc/1/fd/1 2>&1 &

echo "Starting Jupyter Server..."
MATPLOTLIBRC=/root/.config/matplotlib/.matplotlibrc jupyter server --ip=0.0.0.0 --no-browser --IdentityProvider.token=""
