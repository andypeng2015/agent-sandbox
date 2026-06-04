package api

// ListRequest curl -X POST -H "X-Access-Token: 233821641cec431591dc01935eb2f8dd" -H "Connect-Protocol-Version: 1" -H "Content-Type: application/json"  http://10.100.19.73:49983/process.Process/List -d "{}"
type ListRequest struct {
}

// Except sbx.commands.run("sudo python -m http.server 8001", timeout=35) not listed. (sudo)

// ListResponse {"processes":[{"config":{"cmd":"/bin/bash", "args":["-l", "-c", "python -m http.server 8000"]}, "pid":212}, {"config":{"cmd":"/bin/bash", "args":["-l", "-c", ".venv/bin/uvicorn main:app --host 0.0.0.0 --port 44444"], "cwd":"/root/.server"}, "pid":219}]}
type ListResponse struct {
	Processes []ProcessInfo `json:"processes"`
}

//	StartRequest curl --request POST \
//	 --url 'http://10.100.19.73:49983/process.Process/Start' \
//	 --header 'Connect-Protocol-Version: 1 \
//	 --header 'Content-Type: application/connect+json' \
//	 --header 'X-Access-Token: <api-key>' \
//	 --data '
//
//	{
//	 "process": {
//	   "cmd": "<string>",
//	   "args": [
//	     "<string>"
//	   ],
//	   "envs": {},
//	   "cwd": "<string>"
//	 },
//	 "pty": {
//	   "size": {
//	     "cols": 123,
//	     "rows": 123
//	   }
//	 },
//	 "tag": "<string>",
//	 "stdin": true
//	}
//
// '
type StartRequest struct {
	Process ProcessConfig `json:"process"`
	//PTY     PTY           `json:"pty,omitempty"`
	Tag   string `json:"tag,omitempty"`
	Stdin bool   `json:"stdin,omitempty"`
}

//	StartResponse response: 200:{
//	 "event": {
//	   "data": {
//	     "pty": "aSDinaTvuI8gbWludGxpZnk="
//	   }
//	 }
//	}
type StartResponse struct {
	Event StartResponseEvent `json:"event"`
}

type StartResponseEvent struct {
	Start ProcessInfo `json:"start"`
}

type ProcessInfo struct {
	Config ProcessConfig `json:"config"`
	PID    int           `json:"pid"`
	Tag    string        `json:"tag,omitempty"`
}

type ProcessConfig struct {
	Cmd  string            `json:"cmd,omitempty"`
	Args []string          `json:"args,omitempty"`
	Envs map[string]string `json:"envs,omitempty"`
	Cwd  string            `json:"cwd,omitempty"`
}

type PTY struct {
	Size Size `json:"size,omitempty"`
}

type Size struct {
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`
}
